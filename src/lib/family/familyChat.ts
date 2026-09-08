// Движок семейного чата: WebSocket поверх надёжного хранилища (DO).
// Источник истины — сервер (монотонный seq). WS лишь ускоряет: при любом
// разрыве на (ре)коннекте hello{lastSeq} → backfill добирает всё без дыр.
// Исходящие копятся в outbox (pending) и переотправляются при готовности.
//
// МНОГОГРУППОВОСТЬ: на каждую семью (familyId) — свой экземпляр FamilyEngine
// (своё соединение, курсор, presence, reads). Реестр engines держит их все
// живыми одновременно — две группы синкаются и шлют пуши параллельно.

import { db } from '../../db/db';
import { noteUndecrypted } from './undecrypted';
import { decryptBatch } from './decryptBatch';
import type { FamilyConfig, FamilyMessage, FamilySystemEvent, FamilyTask, FamilyMember } from '../../db/types';
import { getPushSubscription } from '../push';
import { getFamilyConfig, patchFamilyConfig, listFamilyConfigs } from './familyState';
import { assembleFile, splitDataUrl } from './fileTransfer';
import { systemEventText } from './systemMessage';
import { t } from '../i18n';
import { importBoxPrivate, importBoxPublic, openFrom } from '../crypto';
import {
  WORKER_URL,
  adoptSealedKey,
  encFamily,
  publishBoxPub,
  recoverAccess,
  registerMember,
} from './familyKeys';
import { reconnectDelay } from './reconnectDelay';

const WS_URL = 'wss://life-hub-push.xabos161rus.workers.dev';
const PING_MS = 25_000;
// Сколько символов dataURL безопасно уходит одним WS-фреймом. Лимит фрейма —
// 1 МиБ, а полезная нагрузка раздувается шифрованием и JSON примерно в 1,33
// раза; 600 КиБ символов оставляют запас.
const SINGLE_FRAME_LIMIT = 600 * 1024;

type ConnState = 'offline' | 'connecting' | 'online';
// 'key' — личный конверт с новым ключом группы после исключения участника.
// Единственный канал, который НЕ зашифрован общим ключом: в этом весь смысл.
type Channel = 'msg' | 'task' | 'member' | 'key';

// Сигнал звонка (WebRTC): эфемерный, проходит через WS, в БД не пишется.
export type SignalKind = 'offer' | 'answer' | 'ice' | 'decline' | 'hangup' | 'busy' | 'cancel';
export interface SignalFrame {
  from: string | null;
  to: string | null;
  call: string | null;
  kind: SignalKind;
  data: string | null; // шифротекст SDP/ICE (семейный ключ)
}
type RawItem = { seq: number; channel: Channel; itemId: string; senderMemberId: string | null; createdAt: string; ciphertext: string };

function stripMeta<T extends { id: string; seq: number; familyId?: string; pendingNotify?: unknown }>(row: T) {
  const { id, seq, familyId, pendingNotify, ...rest } = row;
  void id;
  void seq;
  void familyId;
  void pendingNotify; // локальный флаг доставки, чужим устройствам он не нужен
  return rest;
}

/** E2E-payload сообщения из строки Dexie — отправляющий конец провода. */
export function msgPayload(m: FamilyMessage): object {
  return {
    text: m.text,
    deletedAt: m.deletedAt ?? null,
    image: m.image ?? null,
    audio: m.audio ?? null,
    audioDur: m.audioDur,
    system: m.system ?? false,
    sys: m.sys ?? null,
    replyTo: m.replyTo ?? null,
    reaction: m.reaction ?? null,
    editedAt: m.editedAt ?? null,
    file: m.file ?? null,
    fileChunk: m.fileChunk ?? null,
    // fileData сюда сознательно НЕ входит: манифест едет лёгким сообщением,
    // содержимое — отдельными чанками, каждый по себе укладывается в 1 МиБ.
  };
}

/** Строка Dexie из расшифрованного payload — принимающий конец провода.
 *  Жёсткий белый список полей: незнакомое поле от нового клиента молча
 *  отбрасывается (поэтому у типизированных сообщений text всегда заполнен).
 *  localFileData — своё собранное содержимое файла: put() заменяет строку
 *  целиком, и echo собственного манифеста иначе стёрло бы его в гонке с ack. */
export function msgRowFromWire(
  familyId: string,
  it: { itemId: string; seq: number; senderMemberId: string | null; createdAt: string },
  p: Record<string, unknown>,
  localFileData: string | null,
): FamilyMessage {
  return {
    clientMsgId: it.itemId,
    familyId,
    seq: it.seq,
    senderMemberId: it.senderMemberId ?? '',
    createdAt: it.createdAt,
    text: String(p.text ?? ''),
    image: (p.image as string | null) ?? null,
    audio: (p.audio as string | null) ?? null,
    audioDur: typeof p.audioDur === 'number' ? p.audioDur : undefined,
    system: Boolean(p.system),
    sys: (p.sys as FamilyMessage['sys']) ?? null,
    replyTo: (p.replyTo as FamilyMessage['replyTo']) ?? null,
    reaction: (p.reaction as FamilyMessage['reaction']) ?? null,
    editedAt: (p.editedAt as string | null) ?? null,
    status: 'acked',
    deletedAt: (p.deletedAt as string | null) ?? null,
    file: (p.file as FamilyMessage['file']) ?? null,
    fileChunk: (p.fileChunk as FamilyMessage['fileChunk']) ?? null,
    fileData: localFileData,
  };
}

// === Один экземпляр на семью ===
class FamilyEngine {
  readonly familyId: string;
  private ws: WebSocket | null = null;
  private state: ConnState = 'offline';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Сколько попыток подряд не дали соединения. Держит паузу между ними —
  // см. reconnectDelay. Обнуляется, как только сервер сказал ready.
  private reconnectAttempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  // Ждём ли ответ на последний пинг. Признак «замороженного» сокета: он
  // OPEN, отправка не падает, но собеседника на том конце уже нет.
  private awaitingPong = false;
  private connecting = false; // фаза fetch-ticket (ws ещё null) — guard от гонки
  private wantConnected = false;

  // Курсор lastSeq: держим в памяти, пишем в db.family с дебаунсом — иначе
  // запись на КАЖДЫЙ item бэкфилла дёргает useLiveQuery-подписчиков (фриз).
  private maxSeqSeen = 0;
  private seqFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private onlineIds: string[] = [];
  private reads: Record<string, number> = {};
  private lastReadSeqMem = 0;

  private itemBuf: RawItem[] = [];
  private itemFlush: ReturnType<typeof setTimeout> | null = null;

  private connListeners = new Set<(s: ConnState) => void>();
  private presenceListeners = new Set<(ids: string[]) => void>();
  private readsListeners = new Set<(r: Record<string, number>) => void>();
  private signalListeners = new Set<(f: SignalFrame) => void>();
  private typingListeners = new Set<(memberId: string) => void>();
  private lastTypingSentAt = 0; // троттл исходящего «печатает…»
  private lastSeen: Record<string, string> = {}; // memberId → ISO последнего выхода из сети
  private lastSeenListeners = new Set<(m: Record<string, string>) => void>();

  constructor(familyId: string) {
    this.familyId = familyId;
  }

  private cfg() {
    return getFamilyConfig(this.familyId);
  }

  // --- подписки/геттеры ---
  connectionState(): ConnState {
    return this.state;
  }
  subscribeConnection(fn: (s: ConnState) => void): () => void {
    this.connListeners.add(fn);
    fn(this.state);
    return () => this.connListeners.delete(fn);
  }
  onlineMembers(): string[] {
    return this.onlineIds;
  }
  subscribePresence(fn: (ids: string[]) => void): () => void {
    this.presenceListeners.add(fn);
    fn(this.onlineIds);
    return () => this.presenceListeners.delete(fn);
  }
  subscribeReads(fn: (r: Record<string, number>) => void): () => void {
    this.readsListeners.add(fn);
    fn(this.reads);
    return () => this.readsListeners.delete(fn);
  }
  subscribeSignals(fn: (f: SignalFrame) => void): () => void {
    this.signalListeners.add(fn);
    return () => this.signalListeners.delete(fn);
  }
  subscribeTyping(fn: (memberId: string) => void): () => void {
    this.typingListeners.add(fn);
    return () => this.typingListeners.delete(fn);
  }
  /** «Печатает…»: эфемерный броадкаст, троттл 2.5 с. Не буферится — если WS
   *  закрыт, просто молчим (индикатор не стоит реконнекта). */
  sendTyping(): void {
    const now = Date.now();
    if (now - this.lastTypingSentAt < 2500) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.lastTypingSentAt = now;
    this.ws.send('{"type":"typing"}');
  }
  subscribeLastSeen(fn: (m: Record<string, string>) => void): () => void {
    this.lastSeenListeners.add(fn);
    fn(this.lastSeen);
    return () => this.lastSeenListeners.delete(fn);
  }
  /** Отправить сигнал звонка адресату (to = memberId). */
  sendSignal(frame: { to: string; call: string; kind: SignalKind; data: string | null }): void {
    this.trySendFrame({ type: 'signal', ...frame });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) void this.connect();
  }

  private setState(s: ConnState) {
    if (s === this.state) return;
    this.state = s;
    this.connListeners.forEach((l) => l(s));
  }
  private setPresence(ids: string[]) {
    this.onlineIds = ids;
    this.presenceListeners.forEach((l) => l(ids));
  }
  private setLastSeen(map: unknown) {
    if (!map || typeof map !== 'object') return;
    this.lastSeen = { ...this.lastSeen, ...(map as Record<string, string>) };
    this.lastSeenListeners.forEach((l) => l(this.lastSeen));
  }
  private notifyReads() {
    this.readsListeners.forEach((l) => l(this.reads));
  }
  private setReadFor(memberId: string, seq: number) {
    if ((this.reads[memberId] ?? 0) >= seq) return;
    this.reads = { ...this.reads, [memberId]: seq };
    this.notifyReads();
  }
  private setAllReads(arr: { memberId: string; seq: number }[]) {
    const next = { ...this.reads };
    let changed = false;
    for (const r of arr) {
      if ((next[r.memberId] ?? 0) < r.seq) {
        next[r.memberId] = r.seq;
        changed = true;
      }
    }
    if (changed) {
      this.reads = next;
      this.notifyReads();
    }
  }

  /** Heartbeat с проверкой ответа.
   *
   *  Мобильная сеть умеет «замораживать» соединение: сокет остаётся в
   *  состоянии OPEN, отправка не падает, а на том конце уже никого нет.
   *  Раньше мы в такой сокет исправно слали пинги и считали связь живой —
   *  сообщения молча не доходили, пока человек сам не перезапустит
   *  приложение. Теперь: нет ответа к следующему пингу — рвём соединение
   *  сами, и обычный механизм переподключения поднимает рабочее. */
  private startPing(sock: WebSocket) {
    this.stopPing();
    this.awaitingPong = false;
    this.pingTimer = setInterval(() => {
      if (sock.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        // Предыдущий пинг остался без ответа — соединение мёртвое.
        this.awaitingPong = false;
        try {
          sock.close();
        } catch {
          /* уже закрывается — переподключение поднимет обработчик onclose */
        }
        return;
      }
      this.awaitingPong = true;
      sock.send('{"t":"ping"}');
    }, PING_MS);
  }
  private stopPing() {
    this.awaitingPong = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // Попытка забрать свой ключ с сервера — не чаще раза в минуту: пачки идут
  // потоком, и без ограничения одна испорченная история устроила бы шквал
  // запросов. Возвращает true, если ключ действительно сменился.
  private lastKeyRecoverAt = 0;
  private async tryRecoverKey(): Promise<FamilyConfig | null> {
    const now = Date.now();
    if (now - this.lastKeyRecoverAt < 60_000) return null;
    this.lastKeyRecoverAt = now;
    try {
      return (await recoverAccess(this.familyId)) ? ((await this.cfg()) ?? null) : null;
    } catch {
      return null; // офлайн — попробуем на следующей пачке
    }
  }

  private bumpSeq(seq: number) {
    if (seq > this.maxSeqSeen) this.maxSeqSeen = seq;
    if (this.seqFlushTimer) return;
    this.seqFlushTimer = setTimeout(() => {
      this.seqFlushTimer = null;
      void this.cfg().then((c) => {
        if (c && this.maxSeqSeen > c.lastSeq) void patchFamilyConfig(this.familyId, { lastSeq: this.maxSeqSeen });
      });
    }, 600);
  }

  // Пакетное применение бэкфилла И живого потока: расшифровка ВНЕ транзакции,
  // запись — в ОДНОЙ транзакции (один wake useLiveQuery вместо сотен).
  // live=true — сообщения пришли в реальном времени (не бэкфилл истории):
  // чужой видимый текст/фото/голос дёргает слушателей звука уведомления.
  private async applyBatch(c: FamilyConfig, items: RawItem[], live = false) {
    // Конверт с новым ключом разбираем ДО остального: он приходит в том же
    // потоке, что и сообщения, зашифрованные уже новой эпохой. Возьмись мы за
    // них раньше — расшифровать было бы нечем, и пачка ушла бы в мусор.
    const mine = items.filter((it) => it.channel === 'key' && it.itemId === c.selfMemberId);
    for (const it of mine) {
      if (await adoptSealedKey(this.familyId, it.ciphertext)) {
        c = (await this.cfg()) ?? c; // конфиг переписан: дальше работаем новым ключом
      }
    }
    // Записи канала ключей уже разобраны выше — остальное расшифровываем
    // пачкой, с одной попыткой забрать свой ключ, если он сменился.
    const batch = await decryptBatch(
      c,
      items.filter((it) => it.channel !== 'key'),
      () => this.tryRecoverKey(),
    );
    const decoded = batch.decoded;
    c = batch.config;
    // Что не поддалось и после обновления ключа — считаем и показываем в чате
    // строкой: честнее пустоты, за которой не видно даже факта потери.
    noteUndecrypted(this.familyId, batch.failed.filter((it) => it.channel === 'msg').length);
    // fileId'ы, которых коснулась эта пачка (пришёл чанк или манифест) — после
    // транзакции по каждому пробуем собрать файл заново.
    const touchedFileIds = new Set<string>();
    await db.transaction('rw', db.familyMessages, db.familyTasks, db.familyMembers, async () => {
      for (const { it, p } of decoded) {
        if (it.channel === 'msg') {
          const local = await db.familyMessages.get(it.itemId);
          if (local && local.seq != null && it.seq <= local.seq) continue;
          const row = msgRowFromWire(this.familyId, it, p, local?.fileData ?? null);
          if (row.file) touchedFileIds.add(row.file.fileId);
          if (row.fileChunk) touchedFileIds.add(row.fileChunk.fileId);
          await db.familyMessages.put(row);
        } else if (it.channel === 'task') {
          const local = await db.familyTasks.get(it.itemId);
          if (!local || it.seq > local.seq) await db.familyTasks.put({ ...(p as unknown as FamilyTask), id: it.itemId, familyId: this.familyId, seq: it.seq });
        } else if (it.channel === 'member') {
          const local = await db.familyMembers.get(it.itemId);
          if (!local || it.seq > local.seq) await db.familyMembers.put({ ...(p as unknown as FamilyMember), id: it.itemId, familyId: this.familyId, seq: it.seq });
        }
      }
    });
    // Сборка ВНЕ транзакции: и бэкфилл, и живой поток проходят здесь — только
    // это место пишет fileData собранного файла в манифест.
    for (const fileId of touchedFileIds) await this.assembleIfPossible(fileId);
    const maxSeq = items.reduce((mx, i) => Math.max(mx, i.seq), c.lastSeq);
    if (maxSeq > c.lastSeq) {
      c.lastSeq = maxSeq;
      this.bumpSeq(maxSeq);
    }
    if (
      live &&
      decoded.some(
        ({ it, p }) =>
          it.channel === 'msg' &&
          it.senderMemberId &&
          it.senderMemberId !== c.selfMemberId &&
          !p.system &&
          !p.reaction &&
          !p.deletedAt &&
          !p.fileChunk, // кусок файла — служебная запись, звук уведомления не нужен
      )
    ) {
      incomingListeners.forEach((l) => l(this.familyId));
    }
  }

  /** Пробует собрать файл по fileId из уже сохранённых в db чанков и манифеста.
   *  undefined от assembleFile — нормальное состояние: либо ещё не все чанки
   *  доехали, либо (для старой истории) часть уже вытеснена ретеншном сервера. */
  private async assembleIfPossible(fileId: string): Promise<void> {
    const manifest = await db.familyMessages
      .where('familyId')
      .equals(this.familyId)
      .filter((m) => m.file?.fileId === fileId)
      .first();
    if (!manifest?.file || manifest.fileData) return;
    const chunkRows = await db.familyMessages
      .where('familyId')
      .equals(this.familyId)
      .filter((m) => m.fileChunk?.fileId === fileId)
      .toArray();
    const assembled = assembleFile(
      chunkRows.map((r) => ({ idx: r.fileChunk!.idx, data: r.fileChunk!.data })),
      manifest.file.chunksTotal,
    );
    if (assembled !== undefined) await db.familyMessages.update(manifest.clientMsgId, { fileData: assembled });
  }

  // Микро-очередь живых item: пачка за 50мс применяется одной транзакцией.
  private queueItem(m: RawItem) {
    this.itemBuf.push(m);
    if (this.itemFlush) return;
    this.itemFlush = setTimeout(() => {
      this.itemFlush = null;
      const batch = this.itemBuf;
      this.itemBuf = [];
      void this.cfg().then((fresh) => (fresh ? this.applyBatch(fresh, batch, true) : undefined));
    }, 50);
  }

  // Переотправка неподтверждённого (pending msg + task/member с seq=0).
  private async resendOutbox() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const c = await this.cfg();
    if (!c) return;
    const all = await db.familyMessages.where('familyId').equals(this.familyId).toArray();
    for (const m of all.filter((x) => x.status === 'pending')) {
      this.ws.send(JSON.stringify({
        type: 'send',
        channel: 'msg',
        clientMsgId: m.clientMsgId,
        senderMemberId: m.senderMemberId,
        createdAt: m.createdAt,
        edit: true, // при реконнекте могут быть правки/удаления — пропускаем дедуп
        silent: (m.system ?? false) || Boolean(m.reaction) || Boolean(m.fileChunk),
        ciphertext: await encFamily(c, msgPayload(m)),
      }));
    }
    for (const t of (await db.familyTasks.where('familyId').equals(this.familyId).toArray()).filter((x) => x.seq === 0)) {
      // Отметку «выполнена», не ушедшую из-за отсутствия сети, помечаем снова —
      // иначе она доедет молча. Флаг снимаем сразу: повтор пуша не нужен.
      const notify = t.pendingNotify;
      this.ws.send(JSON.stringify({ type: 'send', channel: 'task', itemId: t.id, senderMemberId: c.selfMemberId, ...(notify ? { notify } : {}), ciphertext: await encFamily(c, stripMeta(t)) }));
      if (notify) await db.familyTasks.update(t.id, { pendingNotify: undefined });
    }
    for (const mem of (await db.familyMembers.where('familyId').equals(this.familyId).toArray()).filter((x) => x.seq === 0)) {
      this.ws.send(JSON.stringify({ type: 'send', channel: 'member', itemId: mem.id, senderMemberId: c.selfMemberId, ciphertext: await encFamily(c, stripMeta(mem)) }));
    }
  }

  async connect() {
    this.wantConnected = true;
    // Guard выставляем СИНХРОННО (до любого await): иначе два почти
    // одновременных connect() (visibilitychange+focus при возврате в PWA) оба
    // пройдут проверку и откроют по сокету на одну группу.
    if (this.connecting) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.connecting = true;
    this.setState('connecting');
    try {
      // let, а не const: после восстановления доступа (смена ключа группы)
      // конфиг перечитывается, и дальше нужен уже новый — со свежим токеном.
      let c = await this.cfg();
      // Движок мог быть снят с реестра (выход/выключение группы), пока читали
      // конфиг. Если так — НЕ открываем сокет: его некому будет закрыть
      // (getEngine создаст новый экземпляр), а зомби писал бы бэкфилл в только
      // что очищенную группу. engines.get(...)===this — инвариант «я актуальный».
      if (!c || !c.enabled || !this.wantConnected || engines.get(this.familyId) !== this) {
        this.connecting = false;
        this.setState('offline');
        return;
      }
      // Нас исключили — переподключаться незачем и нечем. Локальная переписка
      // остаётся: стирать человеку его же историю за то, что его убрали из
      // группы, — лишнее.
      if (c.removedAt) {
        this.wantConnected = false;
        this.connecting = false;
        this.setState('offline');
        return;
      }
      this.lastReadSeqMem = Math.max(this.lastReadSeqMem, c.lastReadSeq ?? 0);
      let tr = await this.fetchTicket(c);
      // 401 после смены ключа группы — обычное дело: пока нас не было, кого-то
      // исключили, и токен сменился. Новый лежит в личном конверте.
      if (tr.status === 401 && (await recoverAccess(this.familyId))) {
        const fresh = await this.cfg();
        if (fresh) {
          c = fresh;
          tr = await this.fetchTicket(fresh);
        }
      }
      if (tr.status === 403) {
        await patchFamilyConfig(this.familyId, { removedAt: new Date().toISOString() });
        this.wantConnected = false;
        this.connecting = false;
        this.setState('offline');
        return;
      }
      if (!tr.ok) throw new Error('ticket');
      const { ticket } = (await tr.json()) as { ticket: string };
      // Ещё раз после сетевой задержки тикета — окно, в котором мог случиться leave.
      if (!this.wantConnected || engines.get(this.familyId) !== this) {
        this.connecting = false;
        this.setState('offline');
        return;
      }
      const sock = new WebSocket(`${WS_URL}/family/ws?familyId=${c.familyId}&ticket=${ticket}`);
      this.ws = sock;
      sock.onopen = () => {
        if (this.ws !== sock) return; // нас уже заменили — этот сокет осиротел
        this.connecting = false;
        sock.send(JSON.stringify({ type: 'hello', lastSeq: c.lastSeq, memberId: c.selfMemberId }));
      };
      sock.onmessage = async (ev) => {
        if (this.ws !== sock) return; // событие осиротевшего сокета — игнор
        const m = JSON.parse(ev.data as string);
        if (m.t === 'pong') {
          this.awaitingPong = false; // связь подтверждена
          return;
        }
        if (m.type === 'backfill') {
          const fresh = await this.cfg();
          if (fresh && m.items?.length) await this.applyBatch(fresh, m.items);
        } else if (m.type === 'ready') {
          this.reconnectAttempt = 0; // связь есть — следующий разрыв начинает счёт заново
          this.setState('online');
          if (Array.isArray(m.online)) this.setPresence(m.online);
          this.setLastSeen(m.lastSeen);
          if (Array.isArray(m.reads)) this.setAllReads(m.reads);
          if (m.name) void patchFamilyConfig(this.familyId, { familyName: String(m.name) });
          this.startPing(sock);
          // Публичный ключ регистрируем на КАЖДОМ подключении, а не только при
          // входе: у тех, кто в группе давно, его нет вовсе, и без него их
          // нечем перевести на новый ключ при исключении кого-то другого.
          await registerMember(this.familyId);
          await publishBoxPub(this.familyId);
          await this.resendOutbox();
          await this.registerPush(c);
        } else if (m.type === 'presence') {
          this.setPresence(Array.isArray(m.online) ? m.online : []);
          this.setLastSeen(m.lastSeen);
        } else if (m.type === 'name') {
          void patchFamilyConfig(this.familyId, { familyName: String(m.name ?? '') });
        } else if (m.type === 'read') {
          if (m.memberId && typeof m.seq === 'number') this.setReadFor(m.memberId, m.seq);
        } else if (m.type === 'item') {
          this.queueItem(m); // батчим — пачка item за 50мс применяется одной транзакцией
        } else if (m.type === 'ack' && m.clientMsgId) {
          await db.familyMessages.update(m.clientMsgId, { status: 'acked', seq: m.seq });
        } else if (m.type === 'signal') {
          this.signalListeners.forEach((l) => l(m as SignalFrame));
        } else if (m.type === 'typing' && typeof m.memberId === 'string') {
          this.typingListeners.forEach((l) => l(m.memberId));
        } else if (m.type === 'removed' && typeof m.memberId === 'string') {
          const mem = await db.familyMembers.get(m.memberId);
          if (mem && !mem.removedAt) {
            await db.familyMembers.update(m.memberId, { removedAt: new Date().toISOString() });
          }
        }
      };
      sock.onclose = (ev: CloseEvent) => {
        if (this.ws !== sock) return; // закрылся осиротевший сокет — актуальный не трогаем
        // 4403 — сервер закрыл соединение исключённому. Реконнект бессмыслен:
        // токен уже сменили, а нового ключа нам не положат.
        if (ev.code === 4403) {
          this.wantConnected = false;
          void patchFamilyConfig(this.familyId, { removedAt: new Date().toISOString() });
        }
        this.ws = null;
        this.connecting = false;
        this.stopPing();
        this.setPresence([]);
        this.setState('offline');
        this.scheduleReconnect();
      };
      sock.onerror = () => sock.close();
    } catch {
      this.connecting = false;
      this.setState('offline');
      this.scheduleReconnect();
    }
  }

  /** Одноразовый тикет на WebSocket. memberId в запросе — чтобы сервер отсёк
   *  исключённого сразу, не дожидаясь, пока до него дойдёт смена токена.
   *
   *  Перед тикетом сервер задаёт задачу: присылает случайное слово,
   *  запечатанное личным ключом участника. Открыть его может только тот, у
   *  кого есть парный приватный ключ, — и тикет тогда ПРИВЯЗЫВАЕТСЯ к этому
   *  участнику. Без привязки любой из группы (токен есть у всех) мог назваться
   *  чужим memberId в hello и получать адресованные тому сигналы звонка.
   *
   *  Для человека не меняется ничего: ни одного нового экрана, кода или
   *  подтверждения — всё внутри подключения. Любая осечка (нет ключа, старый
   *  сервер, чужой формат конверта) молча возвращает прежний путь: лучше
   *  соединение без привязки, чем семья, запертая снаружи собственного чата. */
  private async fetchTicket(c: FamilyConfig): Promise<Response> {
    const base = `familyId=${c.familyId}&memberId=${encodeURIComponent(c.selfMemberId)}`;
    const auth = { Authorization: `Bearer ${c.familyToken}` };
    // Осечка не должна запирать вход — см. комментарий выше.
    const answer = await this.solveChallenge(c, base, auth).catch(() => null);
    return fetch(`${WORKER_URL}/family/ticket?${base}`, {
      method: 'POST',
      headers: answer ? { ...auth, 'Content-Type': 'application/json' } : auth,
      ...(answer ? { body: JSON.stringify(answer) } : {}),
    });
  }

  /** Открыть присланный сервером конверт своим ключом. null — задача не
   *  выдана (у сервера нет нашего публичного ключа) или её нечем открыть. */
  private async solveChallenge(
    c: FamilyConfig,
    base: string,
    auth: Record<string, string>,
  ): Promise<{ challengeId: string; nonce: string } | null> {
    if (!c.boxPriv) return null;
    const res = await fetch(`${WORKER_URL}/family/challenge?${base}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: c.selfMemberId }),
    });
    if (!res.ok) return null; // сервер ещё не умеет задачи — идём прежним путём
    const { challenge } = (await res.json()) as {
      challenge: { challengeId: string; ephPub: string; sealed: string } | null;
    };
    if (!challenge) return null;
    const { nonce } = await openFrom<{ nonce: string }>(
      await importBoxPublic(challenge.ephPub),
      await importBoxPrivate(c.boxPriv),
      challenge.sealed,
    );
    return { challengeId: challenge.challengeId, nonce };
  }

  // Регистрируем push-подписку этого участника в DO — чтобы получать
  // уведомления о сообщениях, когда приложение закрыто (WS мёртв).
  async registerPush(c?: FamilyConfig) {
    const cfg = c ?? (await this.cfg());
    if (!cfg) return;
    const sub = getPushSubscription();
    if (!sub) return;
    try {
      await fetch(`${WORKER_URL}/family/push-sub?familyId=${cfg.familyId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.familyToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: cfg.selfMemberId, subscription: sub }),
      });
    } catch {
      /* офлайн — переедет при следующем ready */
    }
  }

  /** Отписаться от уведомлений группы. Зовётся при выходе — до того, как
   *  локальные данные (а с ними токен) будут стёрты. */
  async unregisterPush(c?: FamilyConfig) {
    const cfg = c ?? (await this.cfg());
    if (!cfg) return;
    try {
      await fetch(`${WORKER_URL}/family/push-unsub?familyId=${cfg.familyId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.familyToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId: cfg.selfMemberId }),
      });
    } catch {
      /* нет сети — уведомления перестанут доходить сами, когда истечёт
         подписка; повторять здесь нечего, группа уже покинута */
    }
  }

  private scheduleReconnect() {
    if (!this.wantConnected || this.reconnectTimer) return;
    const wait = reconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, wait);
  }

  disconnect() {
    this.wantConnected = false;
    this.connecting = false;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this.setPresence([]);
    this.ws?.close();
    this.ws = null;
    this.setState('offline');
  }

  /** true — кадр ушёл в сокет; false — сети не было, ждём resendOutbox. */
  private trySendFrame(frame: object): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
      return true;
    }
    return false; // оставляем в БД — уйдёт на ближайшем ready через resendOutbox
  }

  // Полный E2E-payload сообщения — единая точка сборки (msgPayload) на все
  // пути отправки: sendMessage / edit / delete / resendOutbox шифруют одно и
  // то же, поля не теряются. Вынесена из класса чистой функцией — вместе с
  // зеркальной msgRowFromWire это ОБА конца провода, и их контракт держит
  // юнит-тест (см. systemMessage.test.ts): поле, забытое на любом конце,
  // молча потерялось бы у получателя.

  async sendMessage(text: string, replyTo?: FamilyMessage['replyTo']): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const c = await this.cfg();
    if (!c) return;
    const clientMsgId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const row: FamilyMessage = { clientMsgId, familyId: this.familyId, seq: null, senderMemberId: c.selfMemberId, createdAt, text: body, replyTo: replyTo ?? null, status: 'pending', deletedAt: null };
    await db.familyMessages.put(row);
    this.trySendFrame({ type: 'send', channel: 'msg', clientMsgId, senderMemberId: c.selfMemberId, createdAt, ciphertext: await encFamily(c, msgPayload(row)) });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) void this.connect();
  }

  /** Реакция на сообщение: отдельная append-only запись (не правка чужого
   *  сообщения — E2E-целостность и никаких гонок при одновременных реакциях).
   *  Последняя реакция участника на target побеждает; emoji '' — снятие. */
  async sendReaction(targetId: string, emoji: string): Promise<void> {
    const c = await this.cfg();
    if (!c) return;
    const clientMsgId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const row: FamilyMessage = { clientMsgId, familyId: this.familyId, seq: null, senderMemberId: c.selfMemberId, createdAt, text: '', reaction: { targetId, emoji }, status: 'pending', deletedAt: null };
    await db.familyMessages.put(row);
    this.trySendFrame({ type: 'send', channel: 'msg', clientMsgId, senderMemberId: c.selfMemberId, createdAt, silent: true, ciphertext: await encFamily(c, msgPayload(row)) });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) void this.connect();
  }

  async editMessage(clientMsgId: string, newText: string): Promise<void> {
    const text = newText.trim();
    if (!text) return;
    const c = await this.cfg();
    if (!c) return;
    const m = await db.familyMessages.get(clientMsgId);
    if (!m) return;
    const editedAt = new Date().toISOString();
    await db.familyMessages.update(clientMsgId, { text, editedAt, status: 'pending', seq: null });
    const ciphertext = await encFamily(c, msgPayload({ ...m, text, editedAt }));
    this.trySendFrame({ type: 'send', channel: 'msg', clientMsgId, senderMemberId: m.senderMemberId, createdAt: m.createdAt, edit: true, ciphertext });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) void this.connect();
  }

  async deleteMessage(clientMsgId: string): Promise<void> {
    const c = await this.cfg();
    if (!c) return;
    const m = await db.familyMessages.get(clientMsgId);
    if (!m) return;
    const deletedAt = new Date().toISOString();
    await db.familyMessages.update(clientMsgId, { deletedAt, status: 'pending', seq: null });
    const ciphertext = await encFamily(c, msgPayload({ ...m, deletedAt }));
    this.trySendFrame({ type: 'send', channel: 'msg', clientMsgId, senderMemberId: m.senderMemberId, createdAt: m.createdAt, edit: true, ciphertext });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) void this.connect();
  }

  /** Отправить картинку (сжатый JPEG dataURL) как сообщение-картинку. */
  async sendImage(dataUrl: string): Promise<void> {
    const c = await this.cfg();
    if (!c) return;
    const clientMsgId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await db.familyMessages.put({ clientMsgId, familyId: this.familyId, seq: null, senderMemberId: c.selfMemberId, createdAt, text: '', image: dataUrl, status: 'pending', deletedAt: null });
    this.trySendFrame({ type: 'send', channel: 'msg', clientMsgId, senderMemberId: c.selfMemberId, createdAt, ciphertext: await encFamily(c, { text: '', deletedAt: null, image: dataUrl }) });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) void this.connect();
  }

  /** Отправить голосовое сообщение (аудио dataURL + длительность, сек). */
  /** Отправить голосовое.
   *
   *  Короткая запись уезжает одним сообщением. Длинная — частями, тем же
   *  проверенным путём, что и файлы: минута-две речи после base64 и шифрования
   *  перестаёт помещаться в лимит одного WS-фрейма (1 МиБ), сервер такое
   *  сообщение не принимает, и оно навсегда зависает в очереди, пытаясь
   *  уехать при каждом переподключении, — то есть одна длинная запись
   *  заклинивала весь чат. Длительность едет в манифесте, поэтому у
   *  получателя остаётся обычный плеер, а не карточка файла. */
  async sendAudio(dataUrl: string, durationSec: number): Promise<void> {
    const c = await this.cfg();
    if (!c) return;
    if (dataUrl.length > SINGLE_FRAME_LIMIT) {
      await this.sendFile(
        { name: t('Голосовое сообщение'), mime: 'audio/mp4', size: dataUrl.length, dataUrl },
        durationSec,
      );
      return;
    }
    const clientMsgId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await db.familyMessages.put({ clientMsgId, familyId: this.familyId, seq: null, senderMemberId: c.selfMemberId, createdAt, text: '', audio: dataUrl, audioDur: durationSec, status: 'pending', deletedAt: null });
    this.trySendFrame({ type: 'send', channel: 'msg', clientMsgId, senderMemberId: c.selfMemberId, createdAt, ciphertext: await encFamily(c, { text: '', deletedAt: null, audio: dataUrl, audioDur: durationSec }) });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) void this.connect();
  }

  /** Отправить произвольный файл (dataURL целиком уже на руках — сжатие/чтение
   *  делает UI). Режем на чанки не длиннее CHUNK_RAW_BYTES символов dataURL и
   *  шлём их отдельными silent-сообщениями (как реакции — без пуша на каждый
   *  кусок), затем — манифест: единственное сообщение с пушем и превью «Файл».
   *  fileData манифеста заполняем сразу: у отправителя файл и так на руках,
   *  ждать собственных чанков обратно смысла нет. */
  async sendFile(
    file: { name: string; mime: string; size: number; dataUrl: string },
    audioDur?: number,
  ): Promise<void> {
    const c = await this.cfg();
    if (!c) return;
    const fileId = crypto.randomUUID();
    const parts = splitDataUrl(file.dataUrl);
    const base = Date.now();
    for (let idx = 0; idx < parts.length; idx++) {
      const clientMsgId = crypto.randomUUID();
      // +idx мс — только чтобы порядок pending-сообщений (сортировка по
      // createdAt) шёл чанк-за-чанком перед манифестом; сами чанки не рендерятся.
      const createdAt = new Date(base + idx).toISOString();
      const row: FamilyMessage = {
        clientMsgId,
        familyId: this.familyId,
        seq: null,
        senderMemberId: c.selfMemberId,
        createdAt,
        text: '',
        fileChunk: { fileId, idx, total: parts.length, data: parts[idx] },
        status: 'pending',
        deletedAt: null,
      };
      await db.familyMessages.put(row);
      this.trySendFrame({
        type: 'send',
        channel: 'msg',
        clientMsgId,
        senderMemberId: c.selfMemberId,
        createdAt,
        silent: true,
        ciphertext: await encFamily(c, msgPayload(row)),
      });
    }
    const manifestId = crypto.randomUUID();
    const manifestCreatedAt = new Date(base + parts.length).toISOString();
    const manifestRow: FamilyMessage = {
      clientMsgId: manifestId,
      familyId: this.familyId,
      seq: null,
      senderMemberId: c.selfMemberId,
      createdAt: manifestCreatedAt,
      text: '',
      file: { fileId, name: file.name, mime: file.mime, size: file.size, chunksTotal: parts.length },
      fileData: file.dataUrl,
      // Голосовое, приехавшее частями: длительность отличает его от обычного
      // вложения — получатель рисует плеер, а не карточку файла.
      audioDur,
      status: 'pending',
      deletedAt: null,
    };
    await db.familyMessages.put(manifestRow);
    this.trySendFrame({
      type: 'send',
      channel: 'msg',
      clientMsgId: manifestId,
      senderMemberId: c.selfMemberId,
      createdAt: manifestCreatedAt,
      ciphertext: await encFamily(c, msgPayload(manifestRow)),
    });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) void this.connect();
  }

  /** Системное сообщение (например, «X присоединился») — по центру, без пузыря.
   *  Принимает типизированное событие: kind+params уезжают в payload и
   *  раскрываются в строку у каждого зрителя на его языке; text заполняется
   *  на языке отправителя — fallback для старых клиентов и старой истории.
   *  silent: сервер не шлёт пуш «Новое сообщение» (журнал звонков и прочая
   *  служебка не должны дублировать собственные пуши звонка). */
  async sendSystemMessage(sys: FamilySystemEvent): Promise<void> {
    const c = await this.cfg();
    if (!c) return;
    const clientMsgId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const row: FamilyMessage = { clientMsgId, familyId: this.familyId, seq: null, senderMemberId: c.selfMemberId, createdAt, text: systemEventText(sys), sys, system: true, status: 'pending', deletedAt: null };
    await db.familyMessages.put(row);
    this.trySendFrame({ type: 'send', channel: 'msg', clientMsgId, senderMemberId: c.selfMemberId, createdAt, silent: true, ciphertext: await encFamily(c, msgPayload(row)) });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) void this.connect();
  }

  async renameFamily(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    const c = await this.cfg();
    if (!c) return;
    await patchFamilyConfig(this.familyId, { familyName: trimmed }); // оптимистично
    this.trySendFrame({ type: 'rename', name: trimmed });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) void this.connect();
  }

  markSeen(seq: number): void {
    if (seq <= 0) return;
    this.trySendFrame({ type: 'seen', seq });
    if (seq > this.lastReadSeqMem) {
      this.lastReadSeqMem = seq;
      void patchFamilyConfig(this.familyId, { lastReadSeq: seq });
    }
  }

  /** Возвращает, ушёл ли кадр прямо сейчас: вызывающий решает, помечать ли повтор. */
  async sendItem(channel: 'task' | 'member', itemId: string, payload: object, notify?: 'done'): Promise<boolean> {
    const c = await this.cfg();
    if (!c) return false;
    // notify идёт открытым полем: содержимое зашифровано, и сервер иначе не может
    // отличить «задачу выполнили» от любой другой правки. Тип события — всё, что
    // он узнаёт; ни названия задачи, ни имени в нём нет.
    const sent = this.trySendFrame({ type: 'send', channel, itemId, senderMemberId: c.selfMemberId, ...(notify ? { notify } : {}), ciphertext: await encFamily(c, payload) });
    if (!sent) void this.connect();
    return sent;
  }
}

// Слушатели живых входящих сообщений (для звука уведомления в приложении).
const incomingListeners = new Set<(familyId: string) => void>();
export function subscribeIncoming(fn: (familyId: string) => void): () => void {
  incomingListeners.add(fn);
  return () => incomingListeners.delete(fn);
}

// === Реестр движков (по одному на семью) ===
const engines = new Map<string, FamilyEngine>();
function getEngine(familyId: string): FamilyEngine {
  let e = engines.get(familyId);
  if (!e) {
    e = new FamilyEngine(familyId);
    engines.set(familyId, e);
  }
  return e;
}

/** Поднять/синхронизировать соединения для ВСЕХ включённых групп. Снимает
 *  движки исчезнувших групп, поднимает новые. Идемпотентно. */
export async function connectAllFamilies(): Promise<void> {
  const cfgs = await listFamilyConfigs();
  const enabled = new Set(cfgs.filter((c) => c.enabled).map((c) => c.familyId));
  for (const [fid, e] of engines) {
    if (!enabled.has(fid)) {
      e.disconnect();
      engines.delete(fid);
    }
  }
  for (const fid of enabled) void getEngine(fid).connect();
}

export function disconnectAllFamilies(): void {
  for (const [, e] of engines) e.disconnect();
  engines.clear();
}

/** Зарегистрировать push-подписку этого устройства во ВСЕХ группах (после
 *  включения уведомлений), не дожидаясь следующего WS-ready по каждой. */
export async function registerAllFamilyPush(): Promise<void> {
  const cfgs = await listFamilyConfigs();
  for (const c of cfgs.filter((x) => x.enabled)) await getEngine(c.familyId).registerPush(c);
}

// --- Тонкие обёртки по familyId (UI работает с конкретной группой) ---
export function connectFamily(familyId: string): void {
  void getEngine(familyId).connect();
}
export function disconnectFamily(familyId: string): void {
  const e = engines.get(familyId);
  if (e) {
    e.disconnect();
    engines.delete(familyId);
  }
}
export function connectionState(familyId: string) {
  return getEngine(familyId).connectionState();
}
export function subscribeConnection(familyId: string, fn: (s: ConnState) => void): () => void {
  return getEngine(familyId).subscribeConnection(fn);
}
export function onlineMembers(familyId: string): string[] {
  return getEngine(familyId).onlineMembers();
}
export function subscribePresence(familyId: string, fn: (ids: string[]) => void): () => void {
  return getEngine(familyId).subscribePresence(fn);
}
export function subscribeReads(familyId: string, fn: (r: Record<string, number>) => void): () => void {
  return getEngine(familyId).subscribeReads(fn);
}
export function subscribeLastSeen(familyId: string, fn: (m: Record<string, string>) => void): () => void {
  return getEngine(familyId).subscribeLastSeen(fn);
}
export function sendMessage(familyId: string, text: string, replyTo?: FamilyMessage['replyTo']): Promise<void> {
  return getEngine(familyId).sendMessage(text, replyTo);
}
export function sendReaction(familyId: string, targetId: string, emoji: string): Promise<void> {
  return getEngine(familyId).sendReaction(targetId, emoji);
}
export function sendTyping(familyId: string): void {
  getEngine(familyId).sendTyping();
}
export function subscribeTyping(familyId: string, fn: (memberId: string) => void): () => void {
  return getEngine(familyId).subscribeTyping(fn);
}
export function sendImage(familyId: string, dataUrl: string): Promise<void> {
  return getEngine(familyId).sendImage(dataUrl);
}
export function sendAudio(familyId: string, dataUrl: string, durationSec: number): Promise<void> {
  return getEngine(familyId).sendAudio(dataUrl, durationSec);
}
export function sendFile(familyId: string, file: { name: string; mime: string; size: number; dataUrl: string }): Promise<void> {
  return getEngine(familyId).sendFile(file);
}
export function sendSystemMessage(familyId: string, sys: FamilySystemEvent): Promise<void> {
  return getEngine(familyId).sendSystemMessage(sys);
}
export function editMessage(familyId: string, clientMsgId: string, newText: string): Promise<void> {
  return getEngine(familyId).editMessage(clientMsgId, newText);
}
export function deleteMessage(familyId: string, clientMsgId: string): Promise<void> {
  return getEngine(familyId).deleteMessage(clientMsgId);
}
export function renameFamily(familyId: string, name: string): Promise<void> {
  return getEngine(familyId).renameFamily(name);
}
export function unregisterFamilyPush(familyId: string): Promise<void> {
  return getEngine(familyId).unregisterPush();
}
export function markSeen(familyId: string, seq: number): void {
  getEngine(familyId).markSeen(seq);
}
export function sendItem(familyId: string, channel: 'task' | 'member', itemId: string, payload: object, notify?: 'done'): Promise<boolean> {
  return getEngine(familyId).sendItem(channel, itemId, payload, notify);
}
export function subscribeSignals(familyId: string, fn: (f: SignalFrame) => void): () => void {
  return getEngine(familyId).subscribeSignals(fn);
}
export function sendSignal(
  familyId: string,
  frame: { to: string; call: string; kind: SignalKind; data: string | null },
): void {
  getEngine(familyId).sendSignal(frame);
}
