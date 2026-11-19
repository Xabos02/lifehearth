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
import { sendSignal, sendSystemMessage, connectFamily, connectionSettled, type SignalFrame, type SignalKind } from './familyChat';
import { startRingtone, stopRingtone, startRingback, stopRingback } from './ringtone';
import { tuneOpusSdp } from './callTuning';
import { t } from '../i18n';

import { WORKER_URL } from '../workerUrl';
import { STUN_FALLBACK } from '../consent';
// 45, а не 30 секунд: закрытое приложение будит пуш, и пока человек его
// открыл, а сокет поднялся, полминуты дозвона почти кончались — отвечали в
// последние секунды или уже в «Пропущенный». Тот же срок у сервера
// (CALL_PENDING_TTL_MS в worker/src/familyRoom.js).
const RING_TIMEOUT_MS = 45_000;
// Сколько ждём самовосстановления после 'disconnected' до ICE-restart.
// 6 секунд: короткие провалы мобильной сети укладываются, а человек ещё не
// решил, что связь умерла.
const RECOVERY_GRACE_MS = 6_000;
// Общий срок восстановления — у обеих сторон. Раньше его не было: сторона,
// которой не досталось переигрывать, сдавалась на первом 'failed' молча, а
// инициатор, не дождавшись ответа, висел в «Восстанавливаю связь…» до
// ручного сброса и на перезвон отвечал «Занято».
const RECOVERY_DEADLINE_MS = 40_000;
// /family/turn без ответа не держит звонок: заглохшая сеть ждала бы
// встроенного таймаута браузера — десятки секунд.
const ICE_FETCH_TIMEOUT_MS = 5_000;
// Сколько раз пытаемся переиграть соединение, прежде чем признать поражение,
// и с какой паузой. Числа — из клиента LiveKit: без паузы повтор приходится
// на момент, когда сеть ещё не вернулась, и попытка сгорает впустую.
const MAX_RESTARTS = 5;
const RESTART_BACKOFF_MS = [0, 300, 1200, 2700, 4800];
const OFFER_RESEND_MS = 2500;
// Сколько висеть в «Соединение…» или «Восстанавливаю связь…», чтобы отбой
// (свой или собеседника) считался зависанием и писал разбор. Короче —
// передумали или промахнулись кнопкой, и вердикт «виновата сеть» соврал бы.
// ponytail: порог на глаз — успешный ICE даже через ретранслятор по TLS
// укладывается в несколько секунд; нужна точность — мерить по разборам.
const STUCK_MS = 8_000;
// Как часто снимать статистику пар, пока связь ищется: к концу 25-секундного
// срока движок WebRTC уже удаляет пары без ответа (~15 с), и снимок только в
// конце показал бы «проверок нет».
const STATS_SAMPLE_MS = 2_000;
const ICE_GATHER_CAP_MS = 2000;
// Слуховой динамик среди выходов звука (enumerateDevices, kind 'audiooutput').
// iOS 26 по-английски зовёт его «Earpiece Speaker» (рядом «Main Speaker») —
// по отчёту LiveKit (client-sdk-js issue 1568, июнь 2025). Русское имя не
// найдено нигде — варианты на глаз; не совпало — кнопки «К уху» не будет, а
// имена выходов покажет «Почему звонок не вышел» (CallAudio).
const RECEIVER_LABEL = /earpiece|receiver|приёмник|приемник|трубк|разговорн|верхн/i;
// Что звонок нашёл и выбрал из выходов звука — для разбора: последняя запись.
const AUDIO_KEY = 'life-hub-call-audio';
// Фолбэк на случай недоступности /family/turn: только STUN. TURN-креды
// короткоживущие и приходят с воркера — статических здесь держать нельзя
// (анонимный Open Relay мёртв — проверено).
// Адреса — в перечне внешних хостов (lib/consent.ts), окно согласия их называет.
const DEFAULT_ICE: RTCIceServer[] = STUN_FALLBACK.map((urls) => ({ urls }));

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

interface IceResult {
  servers: RTCIceServer[];
  turn: CallDiag['turn'];
  detail?: string;
}

/** ICE-учётка описания. У повтора того же приглашения она прежняя, у
 *  переигровки соединения после обрыва — новая: так их и различаем. */
function iceUfrag(sdp: string | undefined): string | undefined {
  return /^a=ice-ufrag:(\S+)/m.exec(sdp ?? '')?.[1];
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
  /** Было ли соединение за этот звонок хоть раз — отличает «не встало» от «оборвалось». */
  connected?: boolean;
  /** Проверки маршрутов (STUN-запросы пар): сколько ушло и сколько вернулось
   *  ответов. Ответов ноль — трафик звонка до собеседника не доходит вовсе. */
  checks?: { sent: number; recv: number };
  /** Защищённый канал (DTLS) поверх найденного маршрута: 'connected' |
   *  'failed' | 'connecting' | 'new'. Маршрут есть, а канал нет — режут сам звонок. */
  dtls?: string;
  /** Через что ретранслятор выдал свой адрес: udp / tcp / tls. */
  relayVia?: string[];
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

/** Выходы звука последнего звонка: какие видны, ушёл ли звук «к уху» и чем
 *  кончилась последняя смена выхода. */
export interface CallAudio {
  outputs: string[];
  ear: boolean;
  error?: string;
  /** Сколько мс прошло от касания до отказа — окно Safari 5 с. */
  ms?: number;
}

export function getCallAudio(): CallAudio | null {
  try {
    const raw = localStorage.getItem(AUDIO_KEY);
    return raw ? (JSON.parse(raw) as CallAudio) : null;
  } catch {
    return null;
  }
}

function saveAudio(a: CallAudio): void {
  try {
    localStorage.setItem(AUDIO_KEY, JSON.stringify(a));
  } catch {
    /* приватный режим — разбор не критичен */
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
  // Звук собеседника на iPhone идёт не прямо в <audio>, а через WebAudio:
  // поток → relayCtx → MediaStreamDestination → <audio>. В Safari 26 выбор
  // выхода (setSinkId) для <audio> с единственной WebRTC-дорожкой молча
  // сбрасывается на системный — громкоговоритель (WebKit bug 320087:
  // исправлен в main 29.07.2026, в iOS 26.5 и ветках 7625 исправления нет).
  // Дорожка ретранслятора — локальная, на неё выбор ложится. Фон ретранслятор
  // не глушит: WebKit не прерывает WebAudio свёрнутого приложения, если граф не
  // выведен в ctx.destination или тип audioSession — 'play-and-record'
  // (AudioContext::shouldOverrideBackgroundPlaybackRestriction). Приём тот же,
  // что в LiveKit для iOS 26 (client-sdk-js PR 1635).
  private relayCtx: AudioContext | null = null;
  private relaySrc: MediaStreamAudioSourceNode | null = null;
  private relayOut: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;

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
  // Законченные звонки → что мы сказали собеседнику напоследок (decline/hangup)
  // или null. Звонящий шлёт приглашение повторами, и хвост повторов приходит
  // уже после конца: раньше он звонил заново как новый звонок, а потерянный
  // «Отклонить» оставлял звонящего звать до таймаута.
  private finished = new Map<string, SignalKind | null>();

  // Факты для диагностики — заполняются по ходу звонка.
  private diagTurn: CallDiag['turn'] = 'empty';
  private diagTurnDetail: string | undefined;
  private diagLocal: Record<string, number> = {};
  private diagRemote: Record<string, number> = {};
  private diagIceErrors: string[] = [];
  private restartAttempt = 0; // сколько попыток восстановления уже сделано
  private restarting = false; // переигровка в пути — вторую поверх не начинаем
  private failedGen = -1; // звонок, который уже сдаётся: второй fail() разбор не перезапишет
  private everConnected = false; // соединение за этот звонок было — для разбора
  private connectingAt = 0; // когда начались «Соединение…» / «Восстанавливаю связь…»
  private reconnectingAt = 0;
  // Пиковые счётчики проверок по каждой паре и последнее состояние защищённого
  // канала — копятся, пока связь ищется (см. STATS_SAMPLE_MS).
  private pairPeak = new Map<string, { sent: number; recv: number }>();
  private dtlsSeen: string | undefined;
  private relaySeen = new Set<string>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  // Ретранслятор для входящего берём, пока звонит: к «Ответить» он уже на руках,
  // и ответ уходит на секунду раньше.
  private icePrefetch: Promise<IceResult> | null = null;

  // Громкая связь и «к уху».
  // iOS/Safari: звонок с микрофоном WebKit ведёт в категории PlayAndRecord с
  // опцией DefaultToSpeaker — в громкоговоритель, — и navigator.audioSession
  // 'play-and-record' этого не меняет (AudioSessionIOS.mm, setCategory). Раньше
  // считалось, что меняет: кнопка «К уху» горела, а звук шёл в динамик. На
  // слуховой динамик звук уходит, только если страница сама выберет его
  // выходом: setSinkId на <audio> с устройством-приёмником — тогда WebKit
  // снимает DefaultToSpeaker и включает режим голосового звонка (VoiceChat;
  // коммиты WebKit 19888c4 и 773ecfa, декабрь 2024 — январь 2025).
  // Прочие: тот же setSinkId или смена микрофонного входа (Android Chrome,
  // лейблы 'Speakerphone'/'Headset earpiece' захардкожены в Chromium).
  // Ни один путь не доступен — кнопки нет.
  private speakerMode: 'none' | 'sinkId' | 'inputSwitch' = 'none';
  private receiverSinkId: string | null = null;
  private sinkError: string | undefined; // чем Safari отказал в смене выхода
  private tapAt = 0; // касание «Позвонить»/«Ответить» — от него 5 с на выбор выхода
  private earpieceInputId: string | null = null;
  private speakerInputId: string | null = null;

  // Блокировка гашения экрана. Держим, пока на экран смотрят: дозвон, входящий,
  // соединение, громкая связь. У уха — отпускаем, и экран гаснет и запирается
  // сам, по автоблокировке или боковой кнопкой, как у телефона: датчика
  // приближения у веба нет (в WebKit его нет вовсе, features.json — «Not
  // Considering»), а щека жала кнопки.
  //
  // Раньше экран держали весь разговор: считалось, что погасший экран
  // морозит WebRTC и через 30 с без подтверждения канала звонок умирает
  // (consent freshness, RFC 7675). Для iOS 26 код этого не подтверждает:
  // Safari и веб-приложение с «Домой» объявляют фоновый звук (UIBackgroundModes
  // audio — Info.plist в iOS 26.5), и при таком объявлении WebKit не глушит
  // микрофон скрытой страницы (shouldInterruptAudioOnPageVisibilityChange),
  // а <audio> уход в фон не прерывает. На устройстве не проверено.
  private wakeLock: WakeLockSentinel | null = null;

  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private resendTimer: ReturnType<typeof setInterval> | null = null;
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  // Возврат в приложение: iOS мог заглушить/убить микрофон в фоне — оживляем.
  private visHandler: (() => void) | null = null;

  private armMicRecovery() {
    this.disarmMicRecovery();
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      void this.recoverMicIfDead();
      // Уход в фон отбирает блокировку экрана, а 'connected' при возврате
      // заново не наступает: на громкой связи и на дозвоне её надо вернуть.
      this.syncScreen();
      // Система могла поставить звук собеседника на паузу (звонок GSM, Siri).
      void this.relayCtx?.resume().catch(() => {});
      if (this.audioEl?.srcObject) void this.audioEl.play().catch(() => {});
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
    this.sampleStats();
    this.connTimer = setTimeout(() => {
      this.connTimer = null;
      // Самая частая неудача — и раньше единственная без разбора на экране
      // «Почему звонок не вышел».
      if (this.snap.status === 'connecting') this.fail('Не удалось соединиться — сеть не пропускает звонок');
    }, 25_000);
  }

  /** Звонок кончается не по воле человека: записать разбор, сказать
   *  собеседнику (раньше он узнавал об этом только по своему таймеру, а
   *  то и не узнавал вовсе) и закрыть. Повторный вызов того же звонка —
   *  мимо: второй разбор, снятый уже без соединения, затёр бы первый. */
  private fail(reason: string) {
    if (this.failedGen === this.gen || this.snap.status === 'idle' || this.snap.status === 'ended') return;
    if (this.familyId && this.peerId && this.callId) {
      sendSignal(this.familyId, { to: this.peerId, call: this.callId, kind: 'hangup', data: null });
      this.finished.set(this.callId, 'hangup');
    }
    this.endWithDiag(reason);
  }

  /** Закрыть звонок, сначала записав разбор. Один раз на звонок. */
  private endWithDiag(reason: string) {
    if (this.failedGen === this.gen || this.snap.status === 'idle' || this.snap.status === 'ended') return;
    this.failedGen = this.gen;
    const gen = this.gen;
    void this.writeDiag(reason).finally(() => {
      if (this.gen === gen) this.end(reason);
    });
  }

  private clearRingTimer() {
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
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
    // Гудки — только пока звоним: сняли трубку, отказ, отбой, ошибка — любой
    // уход из «Вызов…» их глушит. Одна проверка здесь, а не в каждом выходе.
    if (p.status && p.status !== 'outgoing') stopRingback();
    if (p.status === 'connecting' && this.snap.status !== 'connecting') this.connectingAt = Date.now();
    if (p.reconnecting && !this.snap.reconnecting) this.reconnectingAt = Date.now();
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

  /** Завести ретранслятор звука (см. relayCtx). Только там, где выход можно
   *  выбрать (Safari 26+), и только в касании: созданный без него AudioContext
   *  Safari держит на паузе. */
  private armRelay() {
    this.tapAt = performance.now();
    if (this.relayCtx || !this.audioSession() || !('setSinkId' in HTMLMediaElement.prototype)) return;
    try {
      const ctx = new AudioContext();
      // Siri, будильник, входящий GSM ставят WebAudio на паузу, не уводя
      // страницу в фон: звук тогда идёт прямо, а не тишиной (см. playRemote).
      ctx.onstatechange = () => this.playRemote();
      void ctx.resume().catch(() => {});
      this.relayCtx = ctx;
    } catch {
      this.relayCtx = null; // WebAudio нет — звук пойдёт прямо в <audio>
    }
  }

  /** Отдать звук собеседника в <audio>: через ретранслятор, если найден
   *  слуховой динамик и ретранслятор запущен, иначе прямо. Звук не теряется
   *  ни в каком случае — без ретранслятора пропадает лишь «к уху». */
  private playRemote() {
    const stream = this.remoteStream;
    if (!stream) return;
    const el = this.ensureAudio();
    const ctx = this.relayCtx;
    let out: MediaStream = stream;
    if (ctx?.state === 'running' && this.speakerMode === 'sinkId') {
      try {
        if (this.relaySrc?.mediaStream !== stream) {
          this.relaySrc?.disconnect();
          const src = ctx.createMediaStreamSource(stream);
          const dest = ctx.createMediaStreamDestination();
          src.connect(dest);
          this.relaySrc = src;
          this.relayOut = dest.stream;
        }
        out = this.relayOut!;
      } catch {
        /* ретранслятор не собрался — играем прямо */
      }
    }
    if (el.srcObject !== out) el.srcObject = out;
    void el.play().catch(() => {});
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
   *  вовсе. Причина осечки возвращается вместе со списком: в разбор её
   *  кладёт звонок, а переигровка по ней решает, менять ли серверы. */
  private async fetchIce(familyId: string): Promise<IceResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ICE_FETCH_TIMEOUT_MS);
    try {
      const c = await getFamilyConfig(familyId);
      if (!c) return { servers: DEFAULT_ICE, turn: 'no-config' };
      const r = await fetch(`${WORKER_URL}/family/turn?familyId=${familyId}`, {
        headers: { Authorization: `Bearer ${c.familyToken}` },
        signal: ctl.signal,
      });
      if (!r.ok) return { servers: DEFAULT_ICE, turn: 'http-error', detail: `HTTP ${r.status}` };
      const d = (await r.json()) as { iceServers?: RTCIceServer[]; turnError?: string };
      const list = Array.isArray(d.iceServers) && d.iceServers.length ? d.iceServers : null;
      // «TURN получен» — это не просто ответ 200, а наличие turn:-адреса:
      // один STUN в ответе на мобильной сети бесполезен.
      const hasTurn = !!list?.some((s) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        return urls.some((u) => typeof u === 'string' && u.startsWith('turn'));
      });
      if (hasTurn) return { servers: list!, turn: 'ok' };
      // Почему без ретранслятора — сервер говорит сам (нет ключей, отказ Cloudflare).
      return { servers: list ?? DEFAULT_ICE, turn: 'empty', detail: d.turnError ? String(d.turnError).slice(0, 60) : undefined };
    } catch (e) {
      return { servers: DEFAULT_ICE, turn: 'network-error', detail: String(e).slice(0, 120) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Нужен ли сейчас включённый экран: звонок идёт и телефон не у уха. */
  private wantsScreen(): boolean {
    const s = this.snap.status;
    if (s === 'idle' || s === 'ended') return false;
    // Только iPhone/Safari (audioSession): на Android «к уху» экран держим, как раньше.
    return !(s === 'active' && !this.snap.speakerOn && !!this.audioSession());
  }

  /** Привести блокировку экрана к состоянию звонка (см. wantsScreen). */
  private syncScreen() {
    if (this.wantsScreen()) void this.holdScreen();
    else this.releaseScreen();
  }

  /** Держать экран включённым. Система отбирает блокировку при уходе в фон —
   *  её возвращает syncScreen по возвращении на экран. */
  private async holdScreen() {
    try {
      if (this.wakeLock || !('wakeLock' in navigator)) return;
      const wl = await navigator.wakeLock.request('screen');
      // Пока система выдавала блокировку, звонок кончился (мгновенное «Нет
      // связи», отказ в микрофоне) или ушёл «к уху», а то и вторая такая же
      // просьба успела раньше, — иначе экран не гас бы до ухода из приложения.
      if (!this.wantsScreen() || this.wakeLock) {
        void wl.release().catch(() => {});
        return;
      }
      this.wakeLock = wl;
      wl.addEventListener('release', () => {
        if (this.wakeLock === wl) this.wakeLock = null;
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
      connected: this.everConnected,
      reason,
    };
    try {
      const stats = await pc?.getStats();
      if (stats) this.notePeaks(stats);
      let finalDtls: string | undefined;
      stats?.forEach(
        (
          s: RTCStats & {
            state?: string;
            localCandidateId?: string;
            remoteCandidateId?: string;
            requestsSent?: number;
            responsesReceived?: number;
            dtlsState?: string;
            candidateType?: string;
            relayProtocol?: string;
          },
        ) => {
          if (s.type === 'candidate-pair' && s.state === 'succeeded') {
            const l = stats.get(s.localCandidateId ?? '') as { candidateType?: string } | undefined;
            const r = stats.get(s.remoteCandidateId ?? '') as { candidateType?: string } | undefined;
            diag.pair = `${l?.candidateType ?? '?'} ↔ ${r?.candidateType ?? '?'}`;
          } else if (s.type === 'transport' && s.dtlsState) {
            finalDtls = s.dtlsState;
          }
        },
      );
      // Канал по ходу мог дойти дальше «new», а к концу закрыться — важнее, докуда дошёл.
      diag.dtls = this.dtlsSeen ?? finalDtls;
    } catch {
      /* статистика недоступна — остальных фактов достаточно */
    }
    let sent = 0;
    let recv = 0;
    for (const p of this.pairPeak.values()) {
      sent += p.sent;
      recv += p.recv;
    }
    if (sent || recv) diag.checks = { sent, recv };
    // relayProtocol отдают Chrome и Android; WebKit пока нет (FIXME в их коде) —
    // на iPhone строка транспорта просто не появится.
    if (this.relaySeen.size) diag.relayVia = [...this.relaySeen].sort();
    saveDiag(diag);
  }

  private sampleStats() {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      void this.pc?.getStats().then((st) => this.notePeaks(st)).catch(() => {});
    }, STATS_SAMPLE_MS);
  }

  private stopStats() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /** Запомнить пиковые счётчики проверок по парам, докуда дошёл защищённый
   *  канал и через что ответил ретранслятор. */
  private notePeaks(stats: RTCStatsReport) {
    stats.forEach(
      (
        s: RTCStats & {
          requestsSent?: number;
          responsesReceived?: number;
          dtlsState?: string;
          candidateType?: string;
          relayProtocol?: string;
        },
      ) => {
        if (s.type === 'candidate-pair') {
          const prev = this.pairPeak.get(s.id);
          this.pairPeak.set(s.id, {
            sent: Math.max(prev?.sent ?? 0, s.requestsSent ?? 0),
            recv: Math.max(prev?.recv ?? 0, s.responsesReceived ?? 0),
          });
        } else if (s.type === 'transport' && s.dtlsState && s.dtlsState !== 'new') {
          this.dtlsSeen = s.dtlsState;
        } else if (s.type === 'local-candidate' && s.candidateType === 'relay' && s.relayProtocol) {
          this.relaySeen.add(s.relayProtocol);
        }
      },
    );
  }

  /** Отбой сейчас — зависание, достойное разбора, или нет. Причина или null. */
  private stuckReason(): string | null {
    if (!this.pc) return null; // разбирать нечего: соединения ещё не заводили
    const now = Date.now();
    if (this.snap.status === 'connecting' && now - this.connectingAt >= STUCK_MS) return 'Соединение не состоялось';
    if (this.snap.reconnecting && now - this.reconnectingAt >= STUCK_MS) return 'Связь не восстановилась';
    return null;
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
    const prefetched = this.icePrefetch;
    this.icePrefetch = null;
    let ice = await (prefetched ?? this.fetchIce(familyId));
    // Предзагрузку входящий запускает в момент пробуждения от пуша, когда сеть
    // и сокет ещё поднимаются, — и сорвавшийся запрос раньше оставлял весь
    // звонок без ретранслятора. На мобильном это верный обрыв: спрашиваем
    // ещё раз, уже к «Ответить». 'no-config' не повторяем — ответ тот же.
    if (prefetched && ice.turn !== 'ok' && ice.turn !== 'no-config') ice = await this.fetchIce(familyId);
    this.diagTurn = ice.turn;
    this.diagTurnDetail = ice.detail;
    // Только ретранслятором на сотовой сети («relay only», как у Jitsi) больше
    // не ходим. Единственный ретранслятор — Cloudflare, а до него из
    // российских сетей связь не гарантирована (с июня 2025 провайдеры режут
    // соединения с Cloudflare): не пробился он — и у звонка не оставалось ни
    // одного маршрута. Со всеми маршрутами ретранслятор всё равно выигрывает
    // там, где прямой путь не встаёт, просто прямой тоже остаётся в игре.
    const pc = new RTCPeerConnection({
      iceServers: ice.servers,
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
        this.remoteStream = stream;
        this.playRemote();
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
        this.everConnected = true;
        this.stopStats();
        this.clearResend();
        this.clearConnTimeout();
        this.clearRecovery();
        this.clearRingTimer();
        if (this.snap.reconnecting) this.set({ reconnecting: false });
        this.restartAttempt = 0; // связь ожила — счётчик попыток с чистого листа
        if (this.snap.status !== 'active') this.set({ status: 'active', startedAt: Date.now() });
        this.syncScreen(); // «к уху» — экран отпускаем, громкая — держим
      } else if (s === 'disconnected' || s === 'failed') {
        // Мобильная сеть роняет соединение на секунды (лифт, переход
        // вышки, WiFi↔LTE) и сама поднимает. Раньше 'disconnected'
        // игнорировался и через мгновение прилетал 'failed' — звонок
        // умирал там, где связь восстановилась бы сама.
        this.beginRecovery(pc, s === 'failed');
      }
    };
    for (const t of this.localStream?.getTracks() ?? []) pc.addTrack(t, this.localStream!);
    this.pc = pc;
    return pc;
  }

  /** Связь пропала. Обе стороны ждут одного общего срока: переигрывает
   *  инициатор, второй держит звонок и отвечает на его приглашение — даже
   *  если инициатор вернётся через полминуты (iOS морозит приложение в
   *  фоне). После 'disconnected' сначала пауза: браузер сам перебирает пары;
   *  'failed' — переигрываем сразу. */
  private beginRecovery(pc: RTCPeerConnection, failed: boolean) {
    if (!this.snap.reconnecting) this.set({ reconnecting: true });
    this.sampleStats();
    // Связь упала — часто вместе с сокетом (смена сети): он остаётся OPEN, но
    // мёртв, и приглашения переигровки уходили в никуда, пока сторож пингов
    // не заметит (25–50 с, дольше срока восстановления). connect() проверит
    // живость сразу и поднимет новый; сигналы дождутся его в очереди.
    if (this.familyId) connectFamily(this.familyId);
    if (!this.deadlineTimer) {
      this.deadlineTimer = setTimeout(() => {
        this.deadlineTimer = null;
        if (this.pc === pc && pc.connectionState !== 'connected') this.fail('Связь не восстановилась');
      }, RECOVERY_DEADLINE_MS);
    }
    if (!this.isRecoveryInitiator()) return; // восстановление ведёт другая сторона
    if (failed) {
      if (this.canRestart()) void this.restartIce(pc);
      return;
    }
    if (this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.pc === pc && pc.connectionState === 'disconnected' && this.canRestart()) void this.restartIce(pc);
    }, RECOVERY_GRACE_MS);
  }

  private clearRecovery() {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    if (this.deadlineTimer) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
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
    if (this.restarting) return; // вторая переигровка поверх первой спутала бы описания
    this.restarting = true;
    this.clearResend(); // копии прошлой переигровки больше не нужны
    const delay = RESTART_BACKOFF_MS[Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1)];
    this.restartAttempt++;
    try {
      const gen = this.gen;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (this.gen !== gen || this.pc !== pc) return;
      // Свежие ICE-серверы: за время разговора креды могли протухнуть, а
      // ретранслятор нужен именно сейчас. setConfiguration меняет их без
      // разрыва соединения. Но только на рабочие: обрыв часто и есть «нет
      // сети», запрос падает, и раньше живой ретранслятор менялся на голый
      // STUN как раз тогда, когда без него не обойтись.
      const ice = await this.fetchIce(this.familyId ?? '');
      if (this.gen !== gen || this.pc !== pc) return;
      if (ice.turn === 'ok') {
        try {
          pc.setConfiguration({ ...pc.getConfiguration(), iceServers: ice.servers });
        } catch {
          /* смена конфигурации не поддержана — идём со старыми серверами */
        }
      }
      pc.restartIce();
      const offer = withOpusTuning(await pc.createOffer({ iceRestart: true }));
      if (this.gen !== gen || this.pc !== pc) return;
      await pc.setLocalDescription(offer);
      if (this.gen !== gen || this.pc !== pc) return;
      await this.waitIce(pc);
      if (this.gen !== gen || this.pc !== pc) return;
      // Повторяем, пока не придёт ответ, — как первое приглашение. Одно
      // приглашение уходило в сокет, который сам ещё переподключался после
      // того же обрыва, и пропадало.
      const send = () => void this.signal('offer', { sdp: pc.localDescription });
      send();
      this.clearResend();
      this.resendTimer = setInterval(send, OFFER_RESEND_MS);
      if (this.snap.status === 'connecting') this.armConnTimeout();
    } catch {
      this.fail('Соединение потеряно');
    } finally {
      this.restarting = false;
    }
  }

  /** Приглашение в звонке, где мы уже ответили. Та же ICE-учётка — это
   *  повтор: наш ответ до звонящего не дошёл (сокет переподключался в момент
   *  ответа), и без повтора он звал бы, а мы ждали, пока оба не сдадутся.
   *  Новая учётка — собеседник переигрывает соединение после обрыва: отвечаем
   *  на неё так же, как на первое приглашение. */
  private async onRepeatOffer(key: CryptoKey, data: string) {
    const pc = this.pc;
    if (!pc) return;
    const { sdp } = await decryptJSON<{ sdp: RTCSessionDescriptionInit }>(key, data);
    // Свой ответ ещё собирается (accept не дошёл до конца) — не вмешиваемся:
    // приглашение повторят через пару секунд.
    if (this.pc !== pc || pc.signalingState !== 'stable' || !pc.remoteDescription) return;
    if (iceUfrag(sdp.sdp) === iceUfrag(pc.remoteDescription.sdp)) {
      if (pc.localDescription?.type === 'answer') {
        void this.signal('answer', { sdp: pc.localDescription, re: iceUfrag(pc.remoteDescription.sdp) });
      }
      return;
    }
    const gen = this.gen;
    try {
      await pc.setRemoteDescription(withOpusTuning(sdp));
      if (this.gen !== gen || this.pc !== pc) return;
      await this.drainCandidates();
      await pc.setLocalDescription(withOpusTuning(await pc.createAnswer()));
      if (this.gen !== gen || this.pc !== pc) return;
      await this.waitIce(pc);
      if (this.gen !== gen || this.pc !== pc) return;
      void this.signal('answer', { sdp: pc.localDescription, re: iceUfrag(sdp.sdp) });
    } catch {
      /* описание отвергнуто или pc закрыт — восстановление ведёт другая сторона */
    }
  }

  /** Маршрут собеседника текущего звонка — в соединение или в очередь. */
  private async applyRemoteCandidate(candidate: RTCIceCandidateInit) {
    const t = this.candType(candidate.candidate);
    this.diagRemote[t] = (this.diagRemote[t] ?? 0) + 1;
    // Пока ждём ответ на переигровку, описание собеседника ещё старое —
    // его новые маршруты оно отвергнет. Придерживаем до ответа.
    if (this.pc && this.pc.remoteDescription && this.pc.signalingState !== 'have-local-offer') {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        /* устаревший кандидат */
      }
    } else {
      this.pendingCandidates.push(candidate);
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
    this.armRelay(); // в касании «Позвонить»: без него Safari не запустит звук
    // Экран не гаснет уже на дозвоне: человек смотрит, взяли ли трубку.
    void this.holdScreen();
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
    // Без связи с сервером приглашение не уйдёт никому — ни сокетом, ни пушем.
    // Раньше тут полминуты висело «Вызов…», а потом «Не ответили», хотя не
    // звонили никому. Исход попытки подключения (её запустил connectFamily
    // выше) узнаём до микрофона: спрашивать разрешение на несостоявшийся
    // звонок незачем.
    // ponytail: ждём без потолка — зависшая сеть держит «Вызов…», пока fetch
    // не сдастся (как и fetchIce ниже); нужен потолок — гонка с RING_TIMEOUT_MS.
    const reachable = await connectionSettled(familyId);
    if (this.gen !== gen) return;
    if (!reachable) {
      this.end('Нет связи с сервером');
      return;
    }
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
    let pc: RTCPeerConnection;
    try {
      pc = await this.createPc(familyId);
      if (this.gen !== gen) return this.abortLocal(pc, stream);
      await pc.setLocalDescription(withOpusTuning(await pc.createOffer()));
      if (this.gen !== gen) return this.abortLocal(pc, stream);
      await this.waitIce(pc);
      if (this.gen !== gen) return this.abortLocal(pc, stream);
    } catch {
      // Раньше исключение здесь оставляло «Вызов…» на весь дозвон.
      if (this.gen === gen) this.fail('Ошибка');
      return;
    }
    const sendOffer = () => void this.signal('offer', { sdp: pc.localDescription });
    sendOffer();
    // Гудки — не здесь, а по сигналу «звонит» (onSignal): приглашение ушло ещё
    // не значит, что у собеседника звонит. Телефон выключен или без сети —
    // гудков нет, как в телефонной сети.
    this.resendTimer = setInterval(sendOffer, OFFER_RESEND_MS);
    this.ringTimer = setTimeout(() => {
      this.ringTimer = null;
      if (this.snap.status !== 'outgoing') return; // трубку уже сняли
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
    this.armRelay(); // в касании «Ответить»: без него Safari не запустит звук
    // Звонящему — сразу «трубку сняли», до микрофона и сбора маршрутов: эти
    // секунды раньше шли в зачёт его дозвона, и ответ на последних секундах
    // он сбрасывал как «Не ответили». Старые версии сигнал пропускают молча.
    void this.signal('accepted', null);
    void this.holdScreen();
    this.armConnTimeout();
    const gen = this.gen;
    const familyId = this.familyId;
    const pendingOffer = this.pendingOffer; // захватываем: end() обнулит this.pendingOffer
    const c = await getFamilyConfig(familyId);
    if (!c) {
      this.fail('Ошибка');
      return;
    }
    if (this.gen !== gen) return;
    let stream: MediaStream;
    try {
      stream = await this.getMic();
    } catch {
      // hangup, а не decline: «трубку сняли» уже ушло, и звонящий отказ после
      // ответа не принимает (см. decline в onSignal). Синхронно, до end():
      // this.signal() читает поля после await, а end() их уже обнулил бы.
      if (this.peerId && this.callId) {
        sendSignal(familyId, { to: this.peerId, call: this.callId, kind: 'hangup', data: null });
        this.finished.set(this.callId, 'hangup');
      }
      this.end('Нет доступа к микрофону');
      return;
    }
    if (this.gen !== gen) return this.abortLocal(null, stream); // снесли, пока брали микрофон
    this.localStream = stream;
    void this.probeSpeaker();
    this.armMicRecovery();
    try {
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
      void this.signal('answer', { sdp: pc.localDescription, re: iceUfrag(offer.sdp.sdp) });
    } catch {
      // Раньше исключение (чужой ключ, отвергнутое описание) молча держало
      // «Соединение…» 25 секунд и сваливало вину на сеть.
      if (this.gen === gen) this.fail('Ошибка');
    }
  }

  decline(): void {
    if (this.familyId && this.peerId && this.callId) {
      sendSignal(this.familyId, { to: this.peerId, call: this.callId, kind: 'decline', data: null });
      this.finished.set(this.callId, 'decline');
    }
    this.end('Отклонено');
  }

  hangup(): void {
    const outgoing = this.snap.status === 'outgoing';
    const stuck = this.stuckReason();
    if (this.familyId && this.peerId && this.callId) {
      const kind = outgoing ? 'cancel' : 'hangup';
      sendSignal(this.familyId, { to: this.peerId, call: this.callId, kind, data: null });
      this.finished.set(this.callId, kind);
    }
    // Нажали «Завершить», устав ждать «Соединение…», — это и есть неудачный
    // звонок: разбор пишет и нажавший, иначе у него экран показывал прошлый.
    if (stuck) {
      this.endWithDiag(stuck);
      return;
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
    this.sinkError = undefined;
    this.earpieceInputId = null;
    this.speakerInputId = null;
    // iOS/Safari: явная телефонная сессия. Маршрут она не задаёт (см.
    // speakerMode), но перебивает тип, оставленный другими разделами: шум
    // «Фокуса» ставит 'playback', а в нём микрофон не пишет.
    const as = this.audioSession();
    if (as) {
      try {
        as.type = 'play-and-record';
      } catch {
        /* тип не поддержан — остаёмся на системном дефолте */
      }
    }
    const audioEl = this.ensureAudio() as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
      webkitShowPlaybackTargetPicker?: () => void;
    };
    // AirPlay-пикер WebKit: системный выбор выхода (AirPods/колонка).
    const outputPickerAvailable = !!as && typeof audioEl.webkitShowPlaybackTargetPicker === 'function';
    const gen = this.gen;
    let outputs: string[] = [];
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      if (this.gen !== gen) return; // звонок снесли, пока перечисляли устройства
      const outs = devs.filter((d) => d.kind === 'audiooutput');
      outputs = outs.map((d) => d.label);
      if (typeof audioEl.setSinkId === 'function') {
        const receiver = outs.find((d) => RECEIVER_LABEL.test(d.label));
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
    // iPhone — «к уху» с первой секунды, как обычный телефонный звонок,
    // громкая — кнопкой. Прочие платформы начинают с системного выхода.
    let ear = false;
    const ctx = this.relayCtx;
    if (as && this.speakerMode === 'sinkId' && ctx) {
      if (ctx.state !== 'running') {
        await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
        if (this.gen !== gen) return;
      }
      // Без запущенного ретранслятора выбор приёмника Safari 26 сбросит (см.
      // relayCtx) — тогда начинаем на громкой, «К уху» запустит его кнопкой.
      // Подключены наушники (выходов больше двух встроенных) — звук остаётся в
      // них, как выбрала система. Выход Safari меняет только в течение 5 с
      // после касания (transient activation): «Позвонить»/«Ответить» обычно
      // укладываются, нет — «К уху» кнопкой. Выход прошлого звонка остался на
      // приёмнике — просить снова не надо.
      if (ctx.state === 'running' && outputs.length === 2) {
        ear = (audioEl as HTMLAudioElement & { sinkId?: string }).sinkId === this.receiverSinkId || (await this.setSink(this.receiverSinkId!));
        if (this.gen !== gen) return;
      }
    } else if (as && this.speakerMode === 'sinkId') {
      this.speakerMode = 'none'; // WebAudio нет — «к уху» в Safari 26 не удержать
    }
    if (as && this.speakerMode !== 'sinkId' && ctx) {
      void ctx.close().catch(() => {}); // слухового нет — ретранслятор не нужен
      this.relayCtx = null;
    }
    this.set({ speakerAvailable: this.speakerMode !== 'none', speakerOn: !ear, outputPickerAvailable });
    if (as) saveAudio({ outputs, ear, error: this.sinkError, ms: this.sinkError ? Math.round(performance.now() - this.tapAt) : undefined });
    this.playRemote(); // ретранслятор мог запуститься уже после прихода звука
    this.syncScreen();
  }

  /** Вывести звук собеседника на устройство; '' — системный выход (на
   *  iPhone — громкоговоритель: WebKit снимает выбор приёмника). */
  private async setSink(id: string): Promise<boolean> {
    const el = this.ensureAudio() as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof el.setSinkId !== 'function') return false;
    // Safari 26.0: первое переключение могло падать — одна повторная попытка.
    this.sinkError = undefined;
    for (let i = 0; i < 2; i++) {
      try {
        await el.setSinkId(id);
        return true;
      } catch (e) {
        this.sinkError = (e as Error)?.name || 'Error'; // NotAllowedError — касание было давно
      }
    }
    return false;
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
    if (this.speakerMode === 'sinkId') {
      const gen = this.gen;
      // Касание — тот момент, когда Safari даст запустить ретранслятор, если
      // при старте разговора он не запустился.
      const ctx = this.relayCtx;
      const resumed = ctx && ctx.state !== 'running' ? ctx.resume().catch(() => {}) : null;
      const ok = await this.setSink(wantOn ? '' : this.receiverSinkId!);
      await resumed;
      if (this.gen !== gen) return;
      this.playRemote();
      // «К уху» в Safari 26 держится только через ретранслятор. Не вышло —
      // состояние кнопки не трогаем.
      const done = ok && (wantOn || !ctx || ctx.state === 'running');
      const a = getCallAudio();
      if (a) saveAudio({ ...a, ear: done ? !wantOn : a.ear, error: this.sinkError, ms: undefined });
      if (!done) {
        // Выход уже на приёмнике, а звук идёт мимо ретранслятора: вернуть, пока
        // касание свежее, — иначе исправленный Safari увёл бы звук к уху молча.
        if (ok && !wantOn) void this.setSink('');
        return;
      }
      this.set({ speakerOn: wantOn });
      this.syncScreen();
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
      this.syncScreen();
    }
  }

  // === Входящие сигналы (роутятся из CallRunner по каждой семье) ===
  async onSignal(familyId: string, f: SignalFrame): Promise<void> {
    if (!f.from || !f.call) return;
    const c = await getFamilyConfig(familyId);
    if (!c) return;
    if (f.to && f.to !== c.selfMemberId) return; // не мне (страховка; сервер уже таргетит)

    if (f.kind === 'offer') {
      // Тот же звонок. Сверяем по callId, а не по статусу: статус ставится
      // после await, и пачка копий приглашения (телефон проснулся и получил
      // всё накопленное разом) проходила проверку «свободен» каждая —
      // с собственным таймером пропущенного, который потом рвал разговор.
      if (this.callId === f.call) {
        if (!this.pc) {
          this.pendingOffer = f.data; // ещё звонит — свежий SDP
          // Звонящий повторяет приглашение — значит, «звонит» до него могло
          // не дойти. Повторяем: одиночный кадр в переподключающийся сокет
          // оставил бы его без гудков.
          if (this.snap.status === 'incoming') void this.signal('ringing', null);
        } else if (f.data) await this.onRepeatOffer(c.familyKey, f.data);
        return;
      }
      if (this.finished.has(f.call)) {
        // Хвост повторов законченного звонка. Наш последний ответ мог
        // потеряться — повторяем его, чтобы звонящий перестал звать.
        const kind = this.finished.get(f.call);
        if (kind) sendSignal(familyId, { to: f.from, call: f.call, kind, data: null });
        return;
      }
      // Занят другим звонком — вежливо отказываем. callId занят раньше
      // статуса (тот ставится после await), поэтому смотрим на оба.
      if (this.callId || (this.snap.status !== 'idle' && this.snap.status !== 'ended')) {
        sendSignal(familyId, { to: f.from, call: f.call, kind: 'busy', data: null });
        return;
      }
      this.cancelDismiss();
      this.familyId = familyId;
      this.peerId = f.from;
      this.callId = f.call;
      this.role = 'callee';
      this.selfId = c.selfMemberId ?? null;
      this.pendingOffer = f.data;
      // Кандидаты, обогнавшие это приглашение, — в очередь текущего звонка.
      // И в разбор: без них «Маршруты собеседника: нет» винило его сторону.
      this.pendingCandidates = this.earlyCandidates.get(f.call) ?? [];
      this.earlyCandidates.clear();
      for (const cand of this.pendingCandidates) {
        const t = this.candType(cand.candidate);
        this.diagRemote[t] = (this.diagRemote[t] ?? 0) + 1;
      }
      const gen = this.gen;
      const name = await this.peerName(f.from).catch(() => t('Участник'));
      // Пока читали имя, звонящий мог уже отменить: его «отбой» из той же
      // пачки обработан раньше. Без этой проверки оставался призрак —
      // звонит, а «Ответить» ничего не делает.
      if (this.gen !== gen || this.callId !== f.call) return;
      this.icePrefetch = this.fetchIce(familyId);
      this.set({ status: 'incoming', familyId, peerId: f.from, peerName: name, muted: false, startedAt: null, endReason: null });
      startRingtone();
      // Звонящему — «у собеседника звонит»: по этому сигналу у него идут гудки.
      // Старые версии сигнал пропускают молча (у них «Вызов…» в тишине).
      void this.signal('ringing', null);
      this.clearRingTimer();
      this.ringTimer = setTimeout(() => {
        this.ringTimer = null;
        if (this.snap.status === 'incoming' && this.callId === f.call) this.end('Пропущенный звонок');
      }, RING_TIMEOUT_MS);
      return;
    }

    if (f.call !== this.callId) {
      // Кандидаты обгоняют offer: сбор ICE у звонящего стартует раньше, чем
      // доставляется приглашение, и первые (самые быстрые) relay-кандидаты
      // прилетают в звонок, которого тут ещё «нет». Придерживаем их — при
      // появлении offer с этим call-id они уйдут в соединение.
      if (f.kind === 'ice' && f.data) {
        // Список кладём в Map ДО расшифровки: кадры приходят пачкой, и каждый,
        // заводя свой пустой список после await, затирал соседей.
        let list = this.earlyCandidates.get(f.call);
        if (!list) {
          list = [];
          this.earlyCandidates.set(f.call, list);
        }
        if (list.length < 40) {
          try {
            const { candidate } = await decryptJSON<{ candidate: RTCIceCandidateInit }>(c.familyKey, f.data);
            // Пока расшифровывали, пришло приглашение этого звонка и забрало
            // очередь — кандидат уже текущего звонка, а не сирота.
            if (this.callId === f.call) await this.applyRemoteCandidate(candidate);
            else list.push(candidate);
          } catch {
            /* чужой ключ — не наш звонок */
          }
        }
      }
      return; // сигнал не текущего звонка
    }

    if (f.kind === 'answer') {
      // Ответ нужен, только пока ждём его на своё приглашение — первое или
      // переигровку после обрыва (её может вести и отвечавший, поэтому роль
      // не проверяем). Копия уже принятого ответа — мимо.
      const pc = this.pc;
      if (!pc || !f.data || pc.signalingState !== 'have-local-offer') return;
      const ans = await decryptJSON<{ sdp: RTCSessionDescriptionInit; re?: string }>(c.familyKey, f.data);
      if (this.pc !== pc || pc.signalingState !== 'have-local-offer') return; // снесён/заменён, пока расшифровывали
      // Ответ на прошлую переигровку, пришедший, когда уже ушла следующая, —
      // не наш: учётки разошлись бы, и проверки маршрутов не сошлись. (re
      // ставят новые версии; у старых его нет — принимаем как раньше.)
      if (ans.re && ans.re !== iceUfrag(pc.localDescription?.sdp)) return;
      try {
        await pc.setRemoteDescription(withOpusTuning(ans.sdp));
      } catch {
        return; // pc закрыт или ответ отвергнут — повтор приглашения добудет новый
      }
      if (this.pc !== pc) return;
      this.clearResend();
      await this.drainCandidates();
      if (this.snap.status === 'outgoing') {
        // Трубку сняли — дальше решает таймер соединения, а не дозвона.
        // Иначе ответ на последних секундах ринга обрывался как «Не ответили»,
        // пока маршрут ещё искался.
        this.clearRingTimer();
        this.set({ status: 'connecting' });
        this.armConnTimeout();
      }
    } else if (f.kind === 'ice') {
      if (!f.data) return;
      const { candidate } = await decryptJSON<{ candidate: RTCIceCandidateInit }>(c.familyKey, f.data);
      await this.applyRemoteCandidate(candidate);
    } else if (f.kind === 'ringing') {
      // У собеседника звонит (его приложение или пуш от сервера) — гудки.
      // Приходит повторами; startRingback повтор не перезапускает.
      if (this.snap.status === 'outgoing') startRingback();
    } else if (f.kind === 'accepted') {
      if (this.snap.status === 'outgoing') {
        // Трубку сняли — дозвон окончен, дальше решает таймер соединения.
        this.clearRingTimer();
        this.set({ status: 'connecting' });
        this.armConnTimeout();
      }
    } else if (f.kind === 'decline' || f.kind === 'busy') {
      // Только пока звоним. Тот же участник на втором устройстве (синхронизация
      // копирует его в группе) мог нажать «Отклонить» уже после ответа с
      // телефона — и раньше этим рвал идущий разговор.
      if (this.snap.status === 'outgoing') this.end(f.kind === 'decline' ? 'Отклонено' : 'Занято');
    } else if (f.kind === 'hangup' || f.kind === 'cancel') {
      // Собеседник сдался, пока связь искалась или восстанавливалась: его срок
      // соединения истёк раньше (у ответившего он идёт с «Ответить»). Разбор
      // пишет и эта сторона — раньше он был только у собеседника, а здесь
      // экран «Почему звонок не вышел» показывал прошлый звонок.
      const stuck = this.stuckReason();
      if (stuck) {
        this.endWithDiag(stuck);
        return;
      }
      // 'idle' — входящий ещё не успел показаться: для человека это тоже пропущенный.
      const ringing = this.snap.status === 'incoming' || this.snap.status === 'idle';
      this.end(ringing ? 'Пропущенный звонок' : 'Звонок завершён');
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
    // его прикрывает missed-пуш от alarm'а. Несостоявшийся звонок (нет
    // микрофона, нет связи) не пишется: «пропущенный» у собеседника значил бы,
    // что ему звонили.
    // Трубку сняли, но связь не встала — тоже не пишется: «пропущенный» в
    // ленте сказал бы, что не ответили, а ответили.
    if (this.role === 'caller' && this.familyId && reason !== 'Нет доступа к микрофону' && reason !== 'Нет связи с сервером') {
      const dur = this.snap.startedAt ? Date.now() - this.snap.startedAt : null;
      if (dur) void sendSystemMessage(this.familyId, { kind: 'call', sec: Math.max(1, Math.floor(dur / 1000)) });
      else if (this.snap.status === 'outgoing') void sendSystemMessage(this.familyId, { kind: 'callMissed' });
    }
    this.gen++; // инвалидирует любой in-flight setup (getMic/createPc/waitIce)
    this.icePrefetch = null;
    if (this.callId && !this.finished.has(this.callId)) this.finished.set(this.callId, null);
    // ponytail: помним последние 20 звонков — хвост повторов живёт секунды.
    for (const id of this.finished.keys()) {
      if (this.finished.size <= 20) break;
      this.finished.delete(id);
    }
    stopRingtone();
    this.clearCallNotifications(this.callId);
    this.clearResend();
    this.clearConnTimeout();
    this.clearRecovery();
    this.disarmMicRecovery();
    this.releaseScreen();
    this.restartAttempt = 0;
    this.everConnected = false;
    this.stopStats();
    this.pairPeak.clear();
    this.dtlsSeen = undefined;
    this.relaySeen.clear();
    this.earlyCandidates.clear();
    // Разбор этого звонка уже записан — следующий начинает с чистого листа.
    // Раньше счётчики копились от звонка к звонку, и «Отказы ретранслятора»
    // могли показывать позавчерашние.
    this.diagTurn = 'empty';
    this.diagTurnDetail = undefined;
    this.diagLocal = {};
    this.diagRemote = {};
    this.diagIceErrors = [];
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
    this.remoteStream = null;
    this.relaySrc?.disconnect();
    this.relaySrc = null;
    this.relayOut = null;
    if (this.relayCtx) {
      void this.relayCtx.close().catch(() => {});
      this.relayCtx = null;
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
    // reconnecting — тоже: залипший флаг следующий звонок принял бы за
    // восстановление, и «пропущенный» записался бы как «Связь не восстановилась».
    this.set({ status: 'ended', endReason: reason, muted: false, speakerOn: true, speakerAvailable: false, outputPickerAvailable: false, startedAt: null, reconnecting: false });
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
