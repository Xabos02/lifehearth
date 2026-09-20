// Живой сигнал о чужих правках (lib/syncLive.ts): что открывается по тикету,
// что чужой сигнал запускает обмен, а свой — нет, что обрыв переподключает
// с растущей паузой, а в фоне не подключается вовсе.
//
// Сеть и сокет подставные: проверяется клиент — куда пошёл, что сделал.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runSync = vi.fn(async () => null);
vi.mock('./sync', async (importOriginal) => {
  const real = await importOriginal<typeof import('./sync')>();
  return { ...real, runSync };
});

const { db } = await import('../db/db');
const { generateKey } = await import('./crypto');
const { getSyncConfig } = await import('./syncState');
const live = await import('./syncLive');

const realFetch = globalThis.fetch;
const RealWebSocket = globalThis.WebSocket;

// DOM в юнитах нет; клиенту от него нужно одно — видна ли страница.
const fakeDocument = { visibilityState: 'visible' as DocumentVisibilityState };
(globalThis as { document?: unknown }).document = fakeDocument;
function setVisibility(v: DocumentVisibilityState) {
  fakeDocument.visibilityState = v;
}

/** Подставной сокет: помнит адрес, отдаёт события наружу. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(data: string) {
    this.onmessage?.({ data });
  }
  send(f: string) {
    this.sent.push(f);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

let ticketCalls = 0;
let ticketStatus = 200;

async function seed() {
  await db.sync.put({
    id: 'config',
    accountId: 'acc-1',
    authToken: 'tok-1',
    key: await generateKey(),
    enabled: true,
    lastPullAt: '',
    lastPushAt: '',
    lastSyncedAt: '',
  } as never);
}

/** Дождаться, пока подключение дойдёт до сокета (тикет — асинхронный). */
async function untilSocket(n = 1) {
  for (let i = 0; i < 100 && FakeSocket.instances.length < n; i++) await new Promise((r) => setTimeout(r, 5));
  return FakeSocket.instances[n - 1];
}

beforeEach(async () => {
  await db.open();
  FakeSocket.instances = [];
  ticketCalls = 0;
  ticketStatus = 200;
  runSync.mockClear();
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/sync/ticket')) {
      ticketCalls++;
      return new Response(JSON.stringify({ ticket: `t-${ticketCalls}` }), { status: ticketStatus });
    }
    throw new Error(`неожиданный запрос: ${url}`);
  }) as typeof fetch;
  setVisibility('visible');
});

afterEach(async () => {
  live.stopSyncLive();
  globalThis.fetch = realFetch;
  globalThis.WebSocket = RealWebSocket;
  vi.useRealTimers();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('подключение', () => {
  it('без настроенного обмена не ходит в сеть вовсе', async () => {
    live.startSyncLive();
    await new Promise((r) => setTimeout(r, 30));
    expect(ticketCalls).toBe(0);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('берёт тикет и открывает сокет своего аккаунта; при открытии — круг вдогонку', async () => {
    await seed();
    live.startSyncLive();
    const sock = await untilSocket();
    expect(ticketCalls).toBe(1);
    expect(sock.url).toContain('/sync/ws?account=acc-1&ticket=t-1');
    // Имя устройства выдано до подключения — по нему фильтруются свои сигналы.
    expect((await getSyncConfig())?.deviceId).toBeTruthy();
    sock.open();
    expect(live.syncLiveConnected()).toBe(true);
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it('в фоне не подключается, а по возвращении — сразу', async () => {
    await seed();
    setVisibility('hidden');
    live.startSyncLive();
    await new Promise((r) => setTimeout(r, 30));
    expect(ticketCalls).toBe(0);
    setVisibility('visible');
    live.kickSyncLive();
    await untilSocket();
    expect(ticketCalls).toBe(1);
  });
});

describe('сигналы', () => {
  it('чужая правка запускает обмен, своя — нет, мусор — молча', async () => {
    await seed();
    live.startSyncLive();
    const sock = await untilSocket();
    sock.open();
    runSync.mockClear();
    const me = (await getSyncConfig())?.deviceId;
    sock.receive(JSON.stringify({ type: 'changed', by: 'other-device' }));
    expect(runSync).toHaveBeenCalledTimes(1);
    sock.receive(JSON.stringify({ type: 'changed', by: me }));
    expect(runSync).toHaveBeenCalledTimes(1);
    sock.receive('not json');
    sock.receive('pong');
    expect(runSync).toHaveBeenCalledTimes(1);
  });
});

describe('обрыв', () => {
  it('переподключается с растущей паузой, а не сразу и не постоянно', async () => {
    await seed();
    live.startSyncLive();
    const first = await untilSocket();
    first.open();
    vi.useFakeTimers();
    first.close();
    // Сразу — нет: пауза не меньше базовой (3 с, см. reconnectDelay).
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticketCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(ticketCalls).toBe(2);
    // Второй обрыв — пауза вдвое длиннее (6–7.5 с): через 4 с попытки ещё нет.
    const second = await untilSocket(2);
    second.open();
    second.close();
    await vi.advanceTimersByTimeAsync(4000);
    expect(ticketCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(ticketCalls).toBe(3);
  });

  it('«открылось и тут же упало» замедляется как обычный отказ; продержалось — счёт с нуля', async () => {
    // Прокси или оператор режут соединение через секунды после открытия:
    // без этого правила каждый круг (тикет, сокет, опрос) шёл бы с базовой
    // паузой — ровно тот режим, что в сентябре выбрал лимит Cloudflare.
    await seed();
    live.startSyncLive();
    const first = await untilSocket();
    first.open();
    vi.useFakeTimers();
    first.close(); // attempt → 1
    await vi.advanceTimersByTimeAsync(4000);
    const second = await untilSocket(2);
    second.open();
    await vi.advanceTimersByTimeAsync(1000);
    second.close(); // открылось и тут же упало: пауза должна расти (6+ с)
    await vi.advanceTimersByTimeAsync(4000);
    expect(ticketCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(ticketCalls).toBe(3);
    const third = await untilSocket(3);
    third.open();
    await vi.advanceTimersByTimeAsync(61_000); // продержалось дольше STABLE_MS
    third.close(); // счёт с нуля: следующая попытка через базовые 3–3.75 с
    await vi.advanceTimersByTimeAsync(4000);
    expect(ticketCalls).toBe(4);
  });

  it('отказ по существу (401/404) не переподключает по таймеру — только по поводу от человека', async () => {
    await seed();
    ticketStatus = 401;
    live.startSyncLive();
    await new Promise((r) => setTimeout(r, 30));
    expect(ticketCalls).toBe(1);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(ticketCalls).toBe(1); // десять минут — ни одной попытки
    vi.useRealTimers();
    ticketStatus = 200;
    live.kickSyncLive(); // вернулись в приложение — пробуем снова
    await untilSocket();
    expect(ticketCalls).toBe(2);
  });

  it('stopSyncLive закрывает сокет и гасит переподключение', async () => {
    await seed();
    live.startSyncLive();
    const sock = await untilSocket();
    sock.open();
    live.stopSyncLive();
    expect(sock.readyState).toBe(3);
    expect(live.syncLiveConnected()).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(ticketCalls).toBe(1);
  });

  it('перезапуск во время получения тикета не оставляет второго сокета', async () => {
    // StrictMode монтирует дважды: start → stop → start, пока первый тикет
    // ещё в пути. Первый заход, дождавшись тикета, не должен открыть сокет
    // рядом с тем, что поднимает второй, — сервер держал бы оба.
    await seed();
    let release: (() => void) | null = null;
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) await new Promise<void>((r) => (release = r)); // первый тикет завис
      return new Response(JSON.stringify({ ticket: `t-${calls}` }), { status: 200 });
    }) as typeof fetch;
    live.startSyncLive();
    await new Promise((r) => setTimeout(r, 20));
    live.stopSyncLive();
    live.startSyncLive();
    const second = await untilSocket();
    expect(second.url).toContain('ticket=t-2');
    release!();
    await new Promise((r) => setTimeout(r, 30));
    // Первый заход отпущен — сокета от него нет.
    expect(FakeSocket.instances).toHaveLength(1);
    second.open();
    expect(live.syncLiveConnected()).toBe(true);
  });

  it('отказ в тикете (500) не роняет приложение — и пробует позже, с паузой', async () => {
    await seed();
    ticketStatus = 500;
    // Таймеры подменяем ДО подключения: пауза переподключения ставится в
    // catch первого захода, и настоящий таймер фальшивые часы не сдвинут.
    vi.useFakeTimers();
    live.startSyncLive();
    await vi.advanceTimersByTimeAsync(50);
    expect(ticketCalls).toBe(1);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(live.syncLiveConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticketCalls).toBe(1); // не раньше базовой паузы
    await vi.advanceTimersByTimeAsync(3000);
    expect(ticketCalls).toBe(2); // «позже» действительно наступает
  });

  it('сеть недоступна (fetch бросает) — тоже попробуем позже, а не навсегда', async () => {
    await seed();
    globalThis.fetch = vi.fn(async () => {
      ticketCalls++;
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    vi.useFakeTimers();
    live.startSyncLive();
    await vi.advanceTimersByTimeAsync(50);
    expect(ticketCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(ticketCalls).toBe(2);
  });
});
