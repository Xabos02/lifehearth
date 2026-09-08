// Аудиозвонки в семье (WebRTC, 1:1). Медиа идёт P2P между устройствами —
// серверу платить не за что. Сигналинг (SDP/ICE) проходит через семейный
// WebSocket и E2E-шифруется тем же семейным ключом, что чат. ICE-серверы
// (STUN бесплатен; TURN-relay из Cloudflare Realtime free tier) берём с Worker.
//
// Надёжность «открой приложение, чтобы ответить»: offer не trickle, а с уже
// собранными ICE-кандидатами в SDP, и переотправляется раз в OFFER_RESEND_MS —
// если адресат подключится позже (по пуш-нуджу), он получит полный offer.

import { useSyncExternalStore } from 'react';
import { db } from '../../db/db';
import { encryptJSON, decryptJSON } from '../crypto';
import { getFamilyConfig } from './familyState';
import { sendSignal, sendSystemMessage, connectFamily, type SignalFrame, type SignalKind } from './familyChat';
import { startRingtone, stopRingtone } from './ringtone';
import { tuneOpusSdp } from './callTuning';
import { t } from '../i18n';

import { WORKER_URL } from '../workerUrl';
const RING_TIMEOUT_MS = 30_000;
// Сколько ждём самовосстановления после 'disconnected' до ICE-restart.
// 6 секунд: короткие провалы мобильной сети укладываются, а человек ещё не
// решил, что связь умерла.
const RECOVERY_GRACE_MS = 6_000;
// Сколько раз пытаемся переиграть соединение, прежде чем признать поражение,
// и с какой паузой. Числа — из клиента LiveKit: без паузы повтор приходится
// на момент, когда сеть ещё не вернулась, и попытка сгорает впустую.
const MAX_RESTARTS = 5;
const RESTART_BACKOFF_MS = [0, 300, 1200, 2700, 4800];
const OFFER_RESEND_MS = 2500;
const ICE_GATHER_CAP_MS = 2000;
// Фолбэк на случай недоступности /family/turn: только STUN. TURN-креды
// короткоживущие и приходят с воркера — статических здесь держать нельзя
// (анонимный Open Relay мёртв — проверено).
const DEFAULT_ICE: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

export type CallStatus = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';

export interface CallSnapshot {
  status: CallStatus;
  familyId: string | null;
  peerId: string | null;
  peerName: string;
  muted: boolean;
  speakerOn: boolean; // громкая связь или «к уху»
  speakerAvailable: boolean; // платформа умеет переключать маршрут — иначе кнопки нет
  // Системный выбор аудиовыхода (AirPods/наушники/колонка) — AirPlay-пикер iOS.
  outputPickerAvailable: boolean;
  startedAt: number | null; // когда соединение стало active (для таймера)
  endReason: string | null;
  /** Восстановление связи после обрыва — показываем вместо мгновенной смерти. */
  reconnecting: boolean;
}

/** Тот же тюнинг, но поверх описания сессии — в этом виде оно и ходит
 *  между createOffer/createAnswer и setLocal/RemoteDescription. */
function withOpusTuning(d: RTCSessionDescriptionInit | null): RTCSessionDescriptionInit {
  return { type: d?.type ?? 'offer', sdp: tuneOpusSdp(d?.sdp) };
}

/** Что произошло со связью на этом устройстве — для экрана «Почему не вышло».
 *  Без этих фактов «Соединение потеряно» неотличимо от десятка разных причин:
 *  не пришли TURN-креды, сеть не пустила relay, оборвался сигналинг. */
export interface CallDiag {
  at: number;
  /** Пришли ли TURN-креды с воркера (без них мобильные сети почти всегда падают). */
  turn: 'ok' | 'no-config' | 'http-error' | 'network-error' | 'empty';
  turnDetail?: string;
  /** Свои ICE-кандидаты по типам: host — своя сеть, srflx — через STUN, relay — через TURN. */
  local: Record<string, number>;
  /** Кандидаты собеседника, дошедшие через сигналинг. */
  remote: Record<string, number>;
  /** Какая пара в итоге выбрана (если соединение состоялось). */
  pair?: string;
  iceState?: string;
  connState?: string;
  /** Отказы ретранслятора: 401 — протухшие креды, 701 — не достучались. */
  iceErrors?: string[];
  /** Сколько раз пытались переиграть соединение до сдачи. */
  restarts?: number;
  reason: string;
}

// Диагностика живёт в localStorage, а не в памяти модуля: разбор нужен уже
// ПОСЛЕ того, как человек в сердцах закрыл приложение, — а с ним умерла бы и
// причина. Одна запись, последняя: история неудач тут никому не нужна.
const DIAG_KEY = 'life-hub-call-diag';

/** Последняя диагностика звонка — читает экран разбора в «Семье». */
export function getCallDiag(): CallDiag | null {
  try {
    const raw = localStorage.getItem(DIAG_KEY);
    return raw ? (JSON.parse(raw) as CallDiag) : null;
  } catch {
    return null;
  }
}

function saveDiag(d: CallDiag): void {
  try {
    localStorage.setItem(DIAG_KEY, JSON.stringify(d));
  } catch {
    /* приватный режим — диагностика не критична */
  }
}

const IDLE: CallSnapshot = {
  status: 'idle',
  familyId: null,
  peerId: null,
  peerName: '',
  muted: false,
  speakerOn: true,
  speakerAvailable: false,
  outputPickerAvailable: false,
  startedAt: null,
  endReason: null,
  reconnecting: false,
};

class CallManager {
  private snap: CallSnapshot = IDLE;
  private listeners = new Set<() => void>();

  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;

  private familyId: string | null = null;
  private peerId: string | null = null;
  // Свой идентификатор в группе — им выбирается сторона, отвечающая за
  // восстановление связи. Заполняется при старте/приёме звонка.
  private selfId: string | null = null;
  private callId: string | null = null;
  private role: 'caller' | 'callee' | null = null;
  private gen = 0; // поколение звонка: end() инкрементит → in-flight setup сверяет и бросает осиротевшие mic/pc

  private pendingOffer: string | null = null; // зашифрованный SDP входящего
  private pendingCandidates: RTCIceCandidateInit[] = [];
  // Кандидаты, прилетевшие ДО того как звонок опознан (сбор ICE стартует раньше,
  // чем доставляется offer). Раньше они молча отбрасывались по несовпадению
  // call-id — а это первые и самые быстрые relay-кандидаты.
  private earlyCandidates = new Map<string, RTCIceCandidateInit[]>();

  // Факты для диагностики — заполняются по ходу звонка.
  private diagTurn: CallDiag['turn'] = 'empty';
  private diagTurnDetail: string | undefined;
  private diagLocal: Record<string, number> = {};
  private diagRemote: Record<string, number> = {};
  private diagIceErrors: string[] = [];
  private restartAttempt = 0; // сколько попыток восстановления уже сделано

  // Громкая связь.
  // iOS/Safari: Audio Session API — type 'play-and-record' ведёт звук «к уху»
  // как обычный телефонный звонок (и позволяет аудио жить в фоне), 'playback' —
  // громкоговоритель. Дефолт на iOS — «к уху», как у телефона.
  // Прочие: setSinkId на <audio> (receiver по label) или смена микрофонного
  // входа (Android Chrome, лейблы 'Speakerphone'/'Headset earpiece' захардкожены
  // в Chromium). Ни один путь не доступен — кнопки нет.
  private speakerMode: 'none' | 'audioSession' | 'sinkId' | 'inputSwitch' = 'none';
  private receiverSinkId: string | null = null;
  private earpieceInputId: string | null = null;
  private speakerInputId: string | null = null;

  // Блокировка гашения экрана на время разговора.
  //
  // Это лечение самой частой причины «поговорили и связь оборвалась» на
  // телефоне: когда экран гаснет, iOS замораживает WebRTC, а спустя 30 секунд
  // без подтверждения канала соединение обязано умереть по спецификации
  // (consent freshness, RFC 7675). Человек в это время просто держит телефон
  // у уха и ничего не трогает.
  private wakeLock: WakeLockSentinel | null = null;

  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private resendTimer: ReturnType<typeof setInterval> | null = null;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  // Возврат в приложение: iOS мог заглушить/убить микрофон в фоне — оживляем.
  private visHandler: (() => void) | null = null;

  private armMicRecovery() {
    this.disarmMicRecovery();
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      void this.recoverMicIfDead();
    };
    document.addEventListener('visibilitychange', onVis);
    this.visHandler = onVis;
  }
  private disarmMicRecovery() {
    if (this.visHandler) {
      document.removeEventListener('visibilitychange', this.visHandler);
      this.visHandler = null;
    }
  }
  /** Микрофонный трек умер/заглушён после фона — берём свежий и подменяем
   *  в отправителе, собеседник снова слышит без переподключения звонка. */
  private async recoverMicIfDead(): Promise<void> {
    const pc = this.pc;
    const stream = this.localStream;
    if (!pc || !stream) return;
    const track = stream.getAudioTracks()[0];
    if (track && track.readyState === 'live' && !track.muted) return; // жив — не трогаем
    const gen = this.gen;
    let fresh: MediaStream;
    try {
      fresh = await this.getMic();
    } catch {
      return; // разрешение потеряно — восстановим при следующем возврате
    }
    if (this.gen !== gen || this.pc !== pc || this.localStream !== stream) {
      for (const t of fresh.getTracks()) t.stop();
      return;
    }
    const newTrack = fresh.getAudioTracks()[0];
    newTrack.enabled = !this.snap.muted;
    const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
    try {
      await sender?.replaceTrack(newTrack);
    } catch {
      for (const t of fresh.getTracks()) t.stop();
      return;
    }
    for (const t of stream.getTracks()) t.stop();
    this.localStream = fresh;
  }
  // Страховка «Соединение…»: ICE не пробился (глухой NAT/VPN без TURN) —
  // честно завершаем вместо вечного спиннера.
  private connTimer: ReturnType<typeof setTimeout> | null = null;

  private armConnTimeout() {
    this.clearConnTimeout();
    this.connTimer = setTimeout(() => {
      this.connTimer = null;
      if (this.snap.status === 'connecting') {
        this.end('Не удалось соединиться — сеть не пропускает звонок');
      }
    }, 25_000);
  }
  private clearConnTimeout() {
    if (this.connTimer) {
      clearTimeout(this.connTimer);
      this.connTimer = null;
    }
  }

  // === стор для useSyncExternalStore ===
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): CallSnapshot => this.snap;
  private set(p: Partial<CallSnapshot>) {
    this.snap = { ...this.snap, ...p };
    this.listeners.forEach((l) => l());
  }

  // Audio Session API (Safari/iOS): управляет системным аудиомаршрутом.
  private audioSession(): { type: string } | null {
    const as = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    return as ?? null;
  }

  private ensureAudio(): HTMLAudioElement {
    if (!this.audioEl) {
      const a = document.createElement('audio');
      a.autoplay = true;
      a.setAttribute('playsinline', '');
      a.style.display = 'none';
      document.body.appendChild(a);
      this.audioEl = a;
    }
    return this.audioEl;
  }

  private async peerName(peerId: string): Promise<string> {
    const m = await db.familyMembers.get(peerId);
    return m?.displayName || t('Участник');
  }

  private getMic(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  }

  /** ICE-серверы с воркера. Раньше любая осечка молча уходила в STUN-only —
   *  а без TURN звонок с мобильной сети (CGNAT у операторов) не соединится
   *  вовсе. Теперь причина осечки записывается в диагностику. */
  private async fetchIce(familyId: string): Promise<RTCIceServer[]> {
    try {
      const c = await getFamilyConfig(familyId);
      if (!c) {
        this.diagTurn = 'no-config';
        return DEFAULT_ICE;
      }
      const r = await fetch(`${WORKER_URL}/family/turn?familyId=${familyId}`, {
        headers: { Authorization: `Bearer ${c.familyToken}` },
      });
      if (!r.ok) {
        this.diagTurn = 'http-error';
        this.diagTurnDetail = `HTTP ${r.status}`;
        return DEFAULT_ICE;
      }
      const d = (await r.json()) as { iceServers?: RTCIceServer[] };
      const list = Array.isArray(d.iceServers) && d.iceServers.length ? d.iceServers : null;
      // «TURN получен» — это не просто ответ 200, а наличие turn:-адреса:
      // один STUN в ответе на мобильной сети бесполезен.
      const hasTurn = !!list?.some((s) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        return urls.some((u) => typeof u === 'string' && u.startsWith('turn'));
      });
      this.diagTurn = hasTurn ? 'ok' : 'empty';
      return list ?? DEFAULT_ICE;
    } catch (e) {
      this.diagTurn = 'network-error';
      this.diagTurnDetail = String(e).slice(0, 120);
      return DEFAULT_ICE;
    }
  }

  /** Держать экран включённым, пока идёт разговор. Система может отобрать
   *  блокировку при уходе в фон — тогда её возвращает armMicRecovery по
   *  возвращении на экран. */
  private async holdScreen() {
    try {
      if (this.wakeLock || !('wakeLock' in navigator)) return;
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
      });
    } catch {
      /* платформа не даёт — не критично, звонок продолжается */
    }
  }

  private releaseScreen() {
    const wl = this.wakeLock;
    this.wakeLock = null;
    if (wl) void wl.release().catch(() => {});
  }

  /** Мобильный интернет? Знание неточное (браузеры отдают тип сети не все и
   *  не всегда), поэтому используется только как подсказка для выбора
   *  relay-only — при неизвестном типе ведём себя как раньше. */
  private cellular(): boolean {
    const c = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string } })
      .connection;
    return c?.type === 'cellular';
  }

  /** Тип ICE-кандидата из SDP-строки: host | srflx | relay | prflx. */
  private candType(sdp: string | undefined): string {
    const m = / typ (\w+)/.exec(sdp ?? '');
    return m ? m[1] : 'unknown';
  }

  /** Снимок фактов о звонке — пишется при завершении, читается экраном разбора. */
  private async writeDiag(reason: string) {
    const pc = this.pc;
    const diag: CallDiag = {
      at: Date.now(),
      turn: this.diagTurn,
      turnDetail: this.diagTurnDetail,
      local: { ...this.diagLocal },
      remote: { ...this.diagRemote },
      iceState: pc?.iceConnectionState,
      connState: pc?.connectionState,
      iceErrors: this.diagIceErrors.length ? [...this.diagIceErrors] : undefined,
      restarts: this.restartAttempt || undefined,
      reason,
    };
    try {
      const stats = await pc?.getStats();
      stats?.forEach((s: RTCStats & { state?: string; localCandidateId?: string; remoteCandidateId?: string }) => {
        if (s.type === 'candidate-pair' && s.state === 'succeeded') {
          const l = stats.get(s.localCandidateId ?? '') as { candidateType?: string } | undefined;
          const r = stats.get(s.remoteCandidateId ?? '') as { candidateType?: string } | undefined;
          diag.pair = `${l?.candidateType ?? '?'} ↔ ${r?.candidateType ?? '?'}`;
        }
      });
    } catch {
      /* статистика недоступна — остальных фактов достаточно */
    }
    saveDiag(diag);
  }

  // Ждём сбор ICE-кандидатов (с потолком), чтобы offer/answer ушли «полными».
  private waitIce(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(done, ICE_GATHER_CAP_MS);
    });
  }

  private async signal(kind: SignalKind, payload: unknown | null) {
    if (!this.familyId || !this.peerId || !this.callId) return;
    const c = await getFamilyConfig(this.familyId);
    if (!c) return;
    const data = payload == null ? null : await encryptJSON(c.familyKey, payload);
    sendSignal(this.familyId, { to: this.peerId, call: this.callId, kind, data });
  }

  private async createPc(familyId: string): Promise<RTCPeerConnection> {
    const iceServers = await this.fetchIce(familyId);
    const pc = new RTCPeerConnection({
      iceServers,
      // Сотовая сеть почти всегда за симметричным CGNAT: прямой путь там не
      // встанет никогда, а перебор host/srflx-пар — это и есть те самые
      // «долгие секунды» перед обрывом. Идём сразу через ретранслятор.
      // Тот же приём у Jitsi (forceTurnRelay). Трафик аудио 1:1 — около
      // 40 МБ в час, при бесплатном лимите 1000 ГБ это ничего не стоит.
      ...(this.cellular() && this.diagTurn === 'ok'
        ? { iceTransportPolicy: 'relay' as RTCIceTransportPolicy }
        : {}),
      // Один транспорт на всё соединение: дефолт 'balanced' собирает
      // отдельные наборы кандидатов на каждый медиапоток и удлиняет сбор.
      bundlePolicy: 'max-bundle',
      // Прогреть кандидатов заранее, не дожидаясь setLocalDescription:
      // пока летит зашифрованное приглашение, маршруты уже собираются.
      iceCandidatePoolSize: 2,
    });
    pc.ontrack = (e) => {
      const [stream] = e.streams;
      if (stream) {
        this.ensureAudio().srcObject = stream;
        void this.audioEl?.play().catch(() => {});
      }
    };
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const t = this.candType(e.candidate.candidate);
      this.diagLocal[t] = (this.diagLocal[t] ?? 0) + 1;
      void this.signal('ice', { candidate: e.candidate.toJSON() });
    };
    // Отказ ретранслятора виден только здесь: 401 — протухшие креды, 701 —
    // до сервера не достучались (порт зарезан сетью). Без этой записи обе
    // причины выглядят одинаково — «просто не соединилось».
    pc.addEventListener('icecandidateerror', (ev) => {
      const e = ev as RTCPeerConnectionIceErrorEvent;
      if (this.diagIceErrors.length < 5) {
        this.diagIceErrors.push(`${e.errorCode} ${String(e.url ?? '').slice(0, 40)}`);
      }
    });
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (this.pc !== pc) return; // событие осиротевшего соединения
      if (s === 'connected') {
        this.clearResend();
        this.clearConnTimeout();
        this.clearRecovery();
        if (this.ringTimer) {
          clearTimeout(this.ringTimer);
          this.ringTimer = null;
        }
        if (this.snap.reconnecting) this.set({ reconnecting: false });
        this.restartAttempt = 0; // связь ожила — счётчик попыток с чистого листа
        void this.holdScreen();
        if (this.snap.status !== 'active') this.set({ status: 'active', startedAt: Date.now() });
      } else if (s === 'disconnected') {
        // Мобильная сеть роняет соединение на секунды (лифт, переход
        // вышки, WiFi↔LTE) и сама поднимает. Раньше этот статус
        // игнорировался и через мгновение прилетал 'failed' — звонок
        // умирал там, где связь восстановилась бы сама.
        this.beginRecovery(pc);
      } else if (s === 'failed') {
        if (this.canRestart()) {
          this.set({ reconnecting: true });
          void this.restartIce(pc);
          return;
        }
        void this.writeDiag('Соединение потеряно').finally(() => this.end('Соединение потеряно'));
      }
    };
    for (const t of this.localStream?.getTracks() ?? []) pc.addTrack(t, this.localStream!);
    this.pc = pc;
    return pc;
  }

  /** Пауза на самовосстановление после 'disconnected'. Не убиваем звонок
   *  сразу: браузер сам перебирает пары. Не вернулись за окно — идём в
   *  ICE-restart через штатный переход в 'failed'. */
  private beginRecovery(pc: RTCPeerConnection) {
    if (this.recoveryTimer) return;
    this.set({ reconnecting: true });
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.pc !== pc) return;
      if (pc.connectionState === 'disconnected') {
        if (this.canRestart()) {
          void this.restartIce(pc);
        } else if (this.isRecoveryInitiator()) {
          // Попытки исчерпаны — дальше тянуть бессмысленно.
          void this.writeDiag('Связь не восстановилась').finally(() => this.end('Связь не восстановилась'));
        }
        // Не инициатор — ждём: восстановление ведёт другая сторона.
      }
    }, RECOVERY_GRACE_MS);
  }

  private clearRecovery() {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  /** Кто переигрывает соединение при обрыве.
   *
   *  Раньше это делал только звонящий — и если именно его телефон уснул или
   *  потерял сеть, восстанавливать разговор было некому. Теперь роль
   *  назначается детерминированно по идентификаторам участников: у обоих
   *  устройств сравнение даёт один и тот же ответ, поэтому переигрывает
   *  ровно одна сторона и встречные offer'ы не сталкиваются. Если своя
   *  сторона не назначена — ждём: инициатор с той стороны нас вытянет. */
  private isRecoveryInitiator(): boolean {
    const self = this.selfId;
    const peer = this.peerId;
    if (!self || !peer) return this.role === 'caller';
    return self < peer;
  }

  private canRestart(): boolean {
    return this.restartAttempt < MAX_RESTARTS && this.isRecoveryInitiator();
  }

  /** Пересобрать маршруты и переиграть приглашение. Попытки идут с растущей
   *  паузой (0 → 0.3 → 1.2 → 2.7 → 4.8 с, как в клиенте LiveKit): мгновенный
   *  повтор в момент, когда сеть ещё не вернулась, просто сжигает попытку. */
  private async restartIce(pc: RTCPeerConnection) {
    const delay = RESTART_BACKOFF_MS[Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1)];
    this.restartAttempt++;
    try {
      const gen = this.gen;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (this.gen !== gen || this.pc !== pc) return;
      // Свежие ICE-серверы: за время разговора креды могли протухнуть, а
      // ретранслятор нужен именно сейчас. setConfiguration меняет их без
      // разрыва соединения.
      const iceServers = await this.fetchIce(this.familyId ?? '');
      if (this.gen !== gen || this.pc !== pc) return;
      try {
        pc.setConfiguration({ ...pc.getConfiguration(), iceServers });
      } catch {
        /* смена конфигурации не поддержана — идём со старыми серверами */
      }
      pc.restartIce();
      const offer = withOpusTuning(await pc.createOffer({ iceRestart: true }));
      if (this.gen !== gen || this.pc !== pc) return;
      await pc.setLocalDescription(offer);
      if (this.gen !== gen || this.pc !== pc) return;
      await this.waitIce(pc);
      if (this.gen !== gen || this.pc !== pc) return;
      void this.signal('offer', { sdp: pc.localDescription });
      this.armConnTimeout();
    } catch {
      void this.writeDiag('Соединение потеряно').finally(() => this.end('Соединение потеряно'));
    }
  }

  private async drainCandidates() {
    if (!this.pc) return;
    for (const cand of this.pendingCandidates) {
      try {
        await this.pc.addIceCandidate(cand);
      } catch {
        /* устаревший кандидат */
      }
    }
    this.pendingCandidates = [];
  }

  // Освобождает mic/pc, захваченные ПОСЛЕ того как звонок был снесён (gen сменился
  // во время await). Чистит ТОЛЬКО переданные локальные ресурсы и отвязывает
  // this.* лишь если они всё ещё указывают на них — чтобы не задеть уже начатый
  // НОВЫЙ звонок.
  private abortLocal(pc: RTCPeerConnection | null, stream: MediaStream | null): void {
    if (pc) {
      try {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.close();
      } catch {
        /* уже закрыт */
      }
      if (this.pc === pc) this.pc = null;
    }
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      if (this.localStream === stream) this.localStream = null;
    }
  }

  // === Исходящий звонок ===
  async startCall(familyId: string, peerId: string): Promise<void> {
    if (this.snap.status !== 'idle' && this.snap.status !== 'ended') return;
    this.cancelDismiss();
    // Статус — СИНХРОННО до любого await: иначе двойной тап «позвонить» прошёл бы
    // guard выше дважды и поднял бы два звонка (два микрофона/pc). Имя дозагрузим.
    this.set({ status: 'outgoing', familyId, peerId, peerName: '', muted: false, startedAt: null, endReason: null });
    connectFamily(familyId);
    this.familyId = familyId;
    this.peerId = peerId;
    this.callId = crypto.randomUUID();
    this.role = 'caller';
    this.pendingCandidates = [];
    const gen = this.gen;
    this.selfId = (await getFamilyConfig(familyId))?.selfMemberId ?? null;
    if (this.gen !== gen) return;
    const name = await this.peerName(peerId);
    if (this.gen !== gen) return;
    this.set({ peerName: name });
    let stream: MediaStream;
    try {
      stream = await this.getMic();
    } catch {
      this.end('Нет доступа к микрофону');
      return;
    }
    if (this.gen !== gen) return this.abortLocal(null, stream); // снесли, пока брали микрофон
    this.localStream = stream;
    void this.probeSpeaker();
    this.armMicRecovery();
    const pc = await this.createPc(familyId);
    if (this.gen !== gen) return this.abortLocal(pc, stream);
    await pc.setLocalDescription(withOpusTuning(await pc.createOffer()));
    if (this.gen !== gen) return this.abortLocal(pc, stream);
    await this.waitIce(pc);
    if (this.gen !== gen) return this.abortLocal(pc, stream);
    const sendOffer = () => void this.signal('offer', { sdp: pc.localDescription });
    sendOffer();
    this.resendTimer = setInterval(sendOffer, OFFER_RESEND_MS);
    this.ringTimer = setTimeout(() => {
      // cancel — синхронно и напрямую (не this.signal: end() обнулит поля до
      // его await). Недоставленный cancel сервер превратит в «пропущенный звонок».
      if (this.familyId && this.peerId && this.callId) {
        sendSignal(this.familyId, { to: this.peerId, call: this.callId, kind: 'cancel', data: null });
      }
      this.end('Не ответили');
    }, RING_TIMEOUT_MS);
  }

  // === Приём входящего ===
  async accept(): Promise<void> {
    if (this.snap.status !== 'incoming' || !this.familyId || !this.peerId || !this.pendingOffer) return;
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
    stopRingtone();
    this.clearCallNotifications(this.callId);
    this.set({ status: 'connecting' }); // синхронно до await — дедуп двойного «Принять»
    this.armConnTimeout();
    const gen = this.gen;
    const familyId = this.familyId;
    const pendingOffer = this.pendingOffer; // захватываем: end() обнулит this.pendingOffer
    const c = await getFamilyConfig(familyId);
    if (!c) {
      this.end('Ошибка');
      return;
    }
    if (this.gen !== gen) return;
    let stream: MediaStream;
    try {
      stream = await this.getMic();
    } catch {
      void this.signal('decline', null);
      this.end('Нет доступа к микрофону');
      return;
    }
    if (this.gen !== gen) return this.abortLocal(null, stream); // снесли, пока брали микрофон
    this.localStream = stream;
    void this.probeSpeaker();
    this.armMicRecovery();
    const offer = await decryptJSON<{ sdp: RTCSessionDescriptionInit }>(c.familyKey, pendingOffer);
    if (this.gen !== gen) return this.abortLocal(null, stream);
    const pc = await this.createPc(familyId);
    if (this.gen !== gen) return this.abortLocal(pc, stream);
    await pc.setRemoteDescription(withOpusTuning(offer.sdp));
    if (this.gen !== gen) return this.abortLocal(pc, stream);
    await this.drainCandidates();
    await pc.setLocalDescription(withOpusTuning(await pc.createAnswer()));
    if (this.gen !== gen) return this.abortLocal(pc, stream);
    await this.waitIce(pc);
    if (this.gen !== gen) return this.abortLocal(pc, stream);
    void this.signal('answer', { sdp: pc.localDescription });
  }

  decline(): void {
    if (this.familyId && this.peerId && this.callId) {
      sendSignal(this.familyId, { to: this.peerId, call: this.callId, kind: 'decline', data: null });
    }
    this.end('Отклонено');
  }

  hangup(): void {
    const outgoing = this.snap.status === 'outgoing';
    if (this.familyId && this.peerId && this.callId) {
      sendSignal(this.familyId, {
        to: this.peerId,
        call: this.callId,
        kind: outgoing ? 'cancel' : 'hangup',
        data: null,
      });
    }
    this.end(outgoing ? 'Отменено' : 'Звонок завершён');
  }

  toggleMute(): void {
    if (!this.localStream) return;
    const newMuted = !this.snap.muted;
    for (const t of this.localStream.getAudioTracks()) t.enabled = !newMuted;
    this.set({ muted: newMuted });
  }

  // Закрыть висящие пуш-карточки «звонит» ТЕКУЩЕГО дозвона: на Android
  // requireInteraction держит их до ручного смахивания даже после ответа.
  // Только свой callId — иначе стёрли бы непросмотренный «пропущенный звонок»
  // другого вызова. На iOS getNotifications исторически пуст — тихий no-op.
  private clearCallNotifications(callId: string | null): void {
    if (!callId) return;
    const tag = 'family-call:' + callId;
    try {
      void navigator.serviceWorker?.ready.then(async (reg) => {
        const ns = await reg.getNotifications();
        for (const n of ns) if (n.tag === tag) n.close();
      });
    } catch {
      /* SW недоступен (например, не-PWA контекст) */
    }
  }

  // Определяем, умеет ли платформа переключать маршрут. Зовётся после getMic —
  // до выдачи разрешения лейблы устройств пустые.
  private async probeSpeaker(): Promise<void> {
    this.speakerMode = 'none';
    this.receiverSinkId = null;
    this.earpieceInputId = null;
    this.speakerInputId = null;
    // iOS/Safari: телефонная аудиосессия. Дефолт — «к уху», как обычный звонок;
    // заодно iOS перестаёт глушить микрофон при сворачивании (VoIP-поведение).
    const as = this.audioSession();
    if (as) {
      this.speakerMode = 'audioSession';
      try {
        as.type = 'play-and-record';
      } catch {
        /* тип не поддержан — остаёмся на системном дефолте */
      }
      // AirPlay-пикер WebKit: системный выбор выхода (AirPods/колонка/телефон).
      const el = this.ensureAudio() as HTMLAudioElement & {
        webkitShowPlaybackTargetPicker?: () => void;
      };
      const hasPicker = typeof el.webkitShowPlaybackTargetPicker === 'function';
      this.set({ speakerAvailable: true, speakerOn: false, outputPickerAvailable: hasPicker });
      return;
    }
    const gen = this.gen;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      if (this.gen !== gen) return; // звонок снесли, пока перечисляли устройства
      const audioEl = this.ensureAudio() as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof audioEl.setSinkId === 'function') {
        const outs = devs.filter((d) => d.kind === 'audiooutput');
        const receiver = outs.find((d) => /receiver|earpiece|приёмник|приемник|трубк/i.test(d.label));
        if (receiver && outs.length >= 2) {
          this.speakerMode = 'sinkId';
          this.receiverSinkId = receiver.deviceId;
        }
      }
      if (this.speakerMode === 'none') {
        const ins = devs.filter((d) => d.kind === 'audioinput');
        const earpiece = ins.find((d) => d.label === 'Headset earpiece');
        const speaker = ins.find((d) => d.label === 'Speakerphone');
        if (earpiece && speaker) {
          this.speakerMode = 'inputSwitch';
          this.earpieceInputId = earpiece.deviceId;
          this.speakerInputId = speaker.deviceId;
        }
      }
    } catch {
      /* enumerateDevices недоступен — остаёмся без кнопки */
    }
    this.set({ speakerAvailable: this.speakerMode !== 'none', speakerOn: true });
  }

  /** Системный выбор аудиовыхода (AirPlay-пикер): AirPods, наушники, колонки.
   *  Требует жеста пользователя — вызывается из кнопки оверлея. */
  showOutputPicker(): void {
    const el = this.ensureAudio() as HTMLAudioElement & {
      webkitShowPlaybackTargetPicker?: () => void;
    };
    try {
      el.webkitShowPlaybackTargetPicker?.();
    } catch {
      /* пикер недоступен */
    }
  }

  async toggleSpeaker(): Promise<void> {
    const wantOn = !this.snap.speakerOn;
    if (this.speakerMode === 'audioSession') {
      const as = this.audioSession();
      if (!as) return;
      try {
        as.type = wantOn ? 'playback' : 'play-and-record';
      } catch {
        return; // маршрут не сменился — состояние кнопки не трогаем
      }
      this.set({ speakerOn: wantOn });
      return;
    }
    if (this.speakerMode === 'sinkId') {
      const audioEl = this.ensureAudio() as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> };
      const target = wantOn ? '' : this.receiverSinkId!;
      try {
        await audioEl.setSinkId(target);
      } catch {
        try {
          await audioEl.setSinkId(target); // Safari 26.0: первый switch мог падать — одна повторная попытка
        } catch {
          return; // маршрут не сменился — состояние кнопки не трогаем
        }
      }
      this.set({ speakerOn: wantOn });
    } else if (this.speakerMode === 'inputSwitch') {
      const targetId = wantOn ? this.speakerInputId : this.earpieceInputId;
      if (!targetId || !this.pc || !this.localStream) return;
      const gen = this.gen;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: targetId },
            // echoCancellation обязателен: только с ним Chrome держит Android
            // в communication-режиме, где и работает переключение маршрута.
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
      } catch {
        return;
      }
      if (this.gen !== gen || !this.pc || !this.localStream) {
        for (const t of stream.getTracks()) t.stop();
        return; // звонок снесли, пока меняли устройство
      }
      const newTrack = stream.getAudioTracks()[0];
      newTrack.enabled = !this.snap.muted;
      const sender = this.pc.getSenders().find((s) => s.track?.kind === 'audio');
      try {
        await sender?.replaceTrack(newTrack);
      } catch {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = stream;
      this.set({ speakerOn: wantOn });
    }
  }

  // === Входящие сигналы (роутятся из CallRunner по каждой семье) ===
  async onSignal(familyId: string, f: SignalFrame): Promise<void> {
    if (!f.from || !f.call) return;
    const c = await getFamilyConfig(familyId);
    if (!c) return;
    if (f.to && f.to !== c.selfMemberId) return; // не мне (страховка; сервер уже таргетит)

    if (f.kind === 'offer') {
      // Повтор offer текущего входящего — просто обновим SDP.
      if (this.snap.status === 'incoming' && this.callId === f.call) {
        this.pendingOffer = f.data;
        return;
      }
      // Занят другим звонком — вежливо отказываем.
      const busy = this.snap.status !== 'idle' && this.snap.status !== 'ended';
      if (busy && this.callId !== f.call) {
        sendSignal(familyId, { to: f.from, call: f.call, kind: 'busy', data: null });
        return;
      }
      if (busy) return;
      this.cancelDismiss();
      this.familyId = familyId;
      this.peerId = f.from;
      this.callId = f.call;
      this.role = 'callee';
      this.selfId = c.selfMemberId ?? null;
      this.pendingOffer = f.data;
      // Кандидаты, обогнавшие это приглашение, — в очередь текущего звонка.
      this.pendingCandidates = this.earlyCandidates.get(f.call) ?? [];
      this.earlyCandidates.clear();
      const name = await this.peerName(f.from);
      this.set({ status: 'incoming', familyId, peerId: f.from, peerName: name, muted: false, startedAt: null, endReason: null });
      startRingtone();
      this.ringTimer = setTimeout(() => this.end('Пропущенный звонок'), RING_TIMEOUT_MS);
      return;
    }

    if (f.call !== this.callId) {
      // Кандидаты обгоняют offer: сбор ICE у звонящего стартует раньше, чем
      // доставляется приглашение, и первые (самые быстрые) relay-кандидаты
      // прилетают в звонок, которого тут ещё «нет». Придерживаем их — при
      // появлении offer с этим call-id они уйдут в соединение.
      if (f.kind === 'ice' && f.data) {
        const list = this.earlyCandidates.get(f.call) ?? [];
        if (list.length < 40) {
          try {
            const { candidate } = await decryptJSON<{ candidate: RTCIceCandidateInit }>(c.familyKey, f.data);
            list.push(candidate);
            this.earlyCandidates.set(f.call, list);
          } catch {
            /* чужой ключ — не наш звонок */
          }
        }
      }
      return; // сигнал не текущего звонка
    }

    if (f.kind === 'answer') {
      if (this.role !== 'caller' || !this.pc || !f.data) return;
      const pc = this.pc;
      this.clearResend();
      const ans = await decryptJSON<{ sdp: RTCSessionDescriptionInit }>(c.familyKey, f.data);
      if (this.pc !== pc) return; // звонок снесён/заменён, пока расшифровывали
      try {
        await pc.setRemoteDescription(withOpusTuning(ans.sdp));
      } catch {
        return; // pc закрыт во время await
      }
      if (this.pc !== pc) return;
      await this.drainCandidates();
      if (this.snap.status === 'outgoing') {
        this.set({ status: 'connecting' });
        this.armConnTimeout();
      }
    } else if (f.kind === 'ice') {
      if (!f.data) return;
      const { candidate } = await decryptJSON<{ candidate: RTCIceCandidateInit }>(c.familyKey, f.data);
      const t = this.candType(candidate.candidate);
      this.diagRemote[t] = (this.diagRemote[t] ?? 0) + 1;
      if (this.pc && this.pc.remoteDescription) {
        try {
          await this.pc.addIceCandidate(candidate);
        } catch {
          /* устаревший кандидат */
        }
      } else {
        this.pendingCandidates.push(candidate);
      }
    } else if (f.kind === 'decline') {
      this.end('Отклонено');
    } else if (f.kind === 'busy') {
      this.end('Занято');
    } else if (f.kind === 'hangup' || f.kind === 'cancel') {
      this.end(this.snap.status === 'incoming' ? 'Пропущенный звонок' : 'Звонок завершён');
    }
  }

  private clearResend() {
    if (this.resendTimer) {
      clearInterval(this.resendTimer);
      this.resendTimer = null;
    }
  }

  private cancelDismiss() {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }

  private end(reason: string) {
    // Журнал звонка в ленту чата пишет ТОЛЬКО звонящий — иначе обе стороны
    // продублировали бы одно событие. Сервер писать не может (E2E: у него нет
    // ключа), поэтому кейс «звонящий умер до таймаута» остаётся без записи —
    // его прикрывает missed-пуш от alarm'а.
    if (this.role === 'caller' && this.familyId && reason !== 'Нет доступа к микрофону') {
      const dur = this.snap.startedAt ? Date.now() - this.snap.startedAt : null;
      void sendSystemMessage(
        this.familyId,
        dur ? { kind: 'call', sec: Math.max(1, Math.floor(dur / 1000)) } : { kind: 'callMissed' },
      );
    }
    this.gen++; // инвалидирует любой in-flight setup (getMic/createPc/waitIce)
    stopRingtone();
    this.clearCallNotifications(this.callId);
    this.clearResend();
    this.clearConnTimeout();
    this.clearRecovery();
    this.disarmMicRecovery();
    this.releaseScreen();
    this.restartAttempt = 0;
    this.earlyCandidates.clear();
    // Вернуть системной аудиосессии обычный режим (iOS).
    {
      const as = this.audioSession();
      if (as) {
        try {
          as.type = 'auto';
        } catch {
          /* не поддержано */
        }
      }
    }
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
    if (this.pc) {
      try {
        this.pc.ontrack = null;
        this.pc.onicecandidate = null;
        this.pc.onconnectionstatechange = null;
        this.pc.close();
      } catch {
        /* уже закрыт */
      }
      this.pc = null;
    }
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }
    if (this.audioEl) {
      try {
        this.audioEl.srcObject = null;
      } catch {
        /* ignore */
      }
      // Скрытый <audio> живёт между звонками: вернуть выход на системный дефолт
      // (громкоговоритель), иначе «К уху» прошлого звонка молча унаследуется
      // следующим при UI, показывающем «Динамик».
      const el = this.audioEl as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof el.setSinkId === 'function') void el.setSinkId('').catch(() => {});
    }
    this.pendingOffer = null;
    this.pendingCandidates = [];
    this.familyId = null;
    this.peerId = null;
    this.callId = null;
    this.role = null;
    this.speakerMode = 'none';
    this.receiverSinkId = null;
    this.earpieceInputId = null;
    this.speakerInputId = null;
    this.set({ status: 'ended', endReason: reason, muted: false, speakerOn: true, speakerAvailable: false, outputPickerAvailable: false, startedAt: null });
    // Показать причину (~2.5с), затем скрыть оверлей.
    this.cancelDismiss();
    this.dismissTimer = setTimeout(() => {
      this.dismissTimer = null;
      if (this.snap.status === 'ended') {
        this.snap = { ...IDLE };
        this.listeners.forEach((l) => l());
      }
    }, 2500);
  }
}

export const callManager = new CallManager();

export function useCall(): CallSnapshot {
  return useSyncExternalStore(callManager.subscribe, callManager.getSnapshot);
}
