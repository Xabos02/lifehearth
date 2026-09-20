// Живой сигнал о чужих правках: сокет к SyncHub своего аккаунта.
//
// Что это. Сервер держит с каждым устройством аккаунта лёгкое соединение и,
// когда одно из них прислало правки, говорит остальным «есть новое — забери».
// Устройство тут же запускает обычный круг обмена (runSync). Сам обмен идёт
// по-прежнему через /sync/push и /sync/pull; по сокету не ходит ни одной
// записи, только сигнал.
//
// Зачем. Без сигнала устройство узнавало о чужой правке на очередном опросе —
// раз в минуту, и только пока приложение на экране. Со стороны это выглядело
// как «на телефоне задача есть, на маке нет».
//
// Сокет — ускоритель, а не транспорт: обрыв ничего не теряет, опрос раз в
// минуту (SyncRunner) остаётся запасным путём. Поэтому здесь нет ни очередей,
// ни подтверждений — только «подключиться, слушать, переподключаться».
//
// Переподключение — с удвоением паузы и разбросом (family/reconnectDelay):
// лежащий сервер не должен превращать каждое открытое окно в тысячи запросов
// в час — так в сентябре 2026 семейный чат выбрал дневной лимит Cloudflare.
// В фоне переподключений нет вовсе: вернулись в приложение — подключимся.

import { authHeaders, currentDeviceId, ensureDeviceId, runSync, WORKER_URL } from './sync';
import { WORKER_WS_URL } from './workerUrl';
import { getSyncConfig } from './syncState';
import { reconnectDelay } from './family/reconnectDelay';

/** Раз в столько шлём ping. На него отвечает сам рантайм сервера, не будя
 *  объект и не тарифицируя; нет ответа к следующему ping — сокет мёртв (сеть
 *  сменилась, мак проснулся), закрываем и открываем заново. Чаще, чем
 *  обычные полминуты-минута простоя, после которых NAT и прокси молча режут
 *  тихие соединения: иначе сокет умирал бы между пингами. */
const PING_MS = 25_000;
/** Сколько соединение должно продержаться, чтобы счёт пауз переподключения
 *  начался заново. Сокет, который открывается и тут же падает (прокси или
 *  оператор режет соединения, объект на сервере не в духе), иначе не
 *  попадал бы под растущую паузу вовсе: каждый круг — тикет, сокет, опрос.
 *  Дольше пары пингов: обрыв, который переживает их, — уже не «сразу». */
const STABLE_MS = 60_000;

let ws: WebSocket | null = null;
let wantConnected = false;
let connecting = false; // фаза «тикет получаем, сокета ещё нет» — от гонки
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let awaitingPong = false;
let stableTimer: ReturnType<typeof setTimeout> | null = null;
// Поколение соединения: растёт на каждый stop/start. Подключение, начатое в
// прошлом поколении (тикет ещё в пути, когда обмен выключили и включили —
// так делает StrictMode при монтировании), не должно завершиться вторым
// сокетом рядом с новым: сервер держал бы оба, а второй никому не нужен.
let generation = 0;

function stopPing(): void {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  awaitingPong = false;
  if (stableTimer) clearTimeout(stableTimer);
  stableTimer = null;
}

function startPing(sock: WebSocket): void {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws !== sock) return stopPing();
    if (awaitingPong) {
      sock.close(); // на прошлый ping не ответили — соединение мертво
      return;
    }
    awaitingPong = true;
    try {
      sock.send('ping');
    } catch {
      sock.close();
    }
  }, PING_MS);
}

function scheduleReconnect(): void {
  if (!wantConnected || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, reconnectDelay(attempt++));
}

async function connect(): Promise<void> {
  if (!wantConnected || connecting || ws) return;
  // В фоне сокет не нужен: на iPhone свёрнутое приложение всё равно стоит,
  // а на маке возврат в окно подключит сразу (kickSyncLive).
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  connecting = true;
  const myGeneration = generation;
  // Поколение сменилось, пока ждали сеть, — этот заход больше никому не нужен.
  const stale = () => generation !== myGeneration || !wantConnected;
  try {
    const stored = await getSyncConfig();
    if (!stored?.enabled || stale()) {
      if (!stale()) connecting = false;
      return;
    }
    const c = await ensureDeviceId(stored);
    const tr = await fetch(`${WORKER_URL}/sync/ticket`, { method: 'POST', headers: authHeaders(c) });
    if (tr.status === 401 || tr.status === 403 || tr.status === 404) {
      // Не сеть моргнула, а сервер отказал по существу: доступа нет (401/403)
      // или живого сигнала он не умеет (404 — старый сервер). Таймер не
      // ставим: до следующего повода от человека (kickSyncLive — возврат в
      // приложение, сеть) стучаться бессмысленно, а опрос раз в минуту
      // продолжает работать и сам скажет, если что.
      if (!stale()) connecting = false;
      return;
    }
    if (!tr.ok) throw new Error(`ticket ${tr.status}`);
    const { ticket } = (await tr.json()) as { ticket: string };
    // Пока ходили за тикетом, обмен могли выключить или перезапустить —
    // тогда сокет уже поднимает другой заход (или не нужен вовсе).
    if (stale() || ws) {
      if (!stale()) connecting = false;
      return;
    }
    const sock = new WebSocket(
      `${WORKER_WS_URL}/sync/ws?account=${encodeURIComponent(c.accountId)}&ticket=${encodeURIComponent(ticket)}`,
    );
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) {
        sock.close(); // нас уже заменили — осиротевший сокет закрываем, а не держим
        return;
      }
      connecting = false;
      startPing(sock);
      // Счёт пауз — с нуля, но только если связь продержалась: «открылось и
      // тут же упало» должно замедляться, как и обычный отказ.
      stableTimer = setTimeout(() => {
        if (ws === sock) attempt = 0;
      }, STABLE_MS);
      // Пока сокета не было, сигналы могли пройти мимо — один круг вдогонку.
      void runSync().catch(() => {});
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (ws !== sock) return;
      const raw = String(ev.data);
      if (raw === 'pong') {
        awaitingPong = false;
        return;
      }
      let m: { type?: string; by?: string };
      try {
        m = JSON.parse(raw) as { type?: string; by?: string };
      } catch {
        return;
      }
      // Свои же правки сервер тоже объявляет — их у нас и так есть. Имя
      // берём живое, не с момента подключения: после «перечитать всё» оно
      // другое, а сокет тот же.
      if (m.type === 'changed' && m.by !== currentDeviceId()) void runSync().catch(() => {});
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      connecting = false;
      stopPing();
      scheduleReconnect();
    };
    sock.onerror = () => sock.close();
  } catch {
    if (stale()) return; // поколение сменилось — переподключаться будет уже оно
    connecting = false;
    scheduleReconnect();
  }
}

/** Держать соединение, пока не позовут stopSyncLive. Без настроенного
 *  обмена — молча ничего не делает (connect проверяет конфиг). */
export function startSyncLive(): void {
  generation++;
  wantConnected = true;
  connecting = false;
  void connect();
}

/** Подтолкнуть: вернулись в приложение, появилась сеть. Живому сокету не
 *  мешает, оборванный — поднимает сразу, не дожидаясь таймера. */
export function kickSyncLive(): void {
  if (!wantConnected) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  attempt = 0; // повод от человека — счёт пауз заново, даже после отказа
  void connect();
}

export function stopSyncLive(): void {
  generation++;
  wantConnected = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopPing();
  const sock = ws;
  ws = null;
  connecting = false;
  attempt = 0;
  try {
    sock?.close();
  } catch {
    /* уже закрыт */
  }
}

/** Есть ли сейчас живое соединение (для тестов и отладки). */
export function syncLiveConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}
