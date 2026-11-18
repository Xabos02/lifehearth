// Напоминания и рассылка: сервер не должен зависать на чужом адресе и не
// должен принимать адрес куда попало (аудит 1.64.0: NEW-S-1, S5).
//
// Как это ломалось. Крон шлёт пуши по очереди и снимает строку только после
// ответа. У fetch не было срока: один адрес, который принимает соединение и
// молчит, держал цикл — и все напоминания после него не уходили, а строка
// оставалась и останавливала следующий запуск тоже. Поставить такой адрес мог
// кто угодно: /schedule принимал любой endpoint без авторизации.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToB64url } from './src/webpush.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const worker = (await import('./src/index.js')).default as {
  fetch: (r: Request, e: unknown, c: unknown) => Promise<Response>;
  scheduled: (ev: unknown, e: unknown, c: { waitUntil(p: Promise<unknown>): void }) => Promise<void>;
};
const ORIGIN = 'https://xabos02.github.io';

/** Настоящая подписка браузера по форме: P-256 ключ и 16 байт auth, —
 *  иначе buildPushRequest упадёт до fetch и тест ничего не проверит. */
async function subscription(endpoint: string) {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { endpoint, keys: { p256dh: bytesToB64url(pub), auth: bytesToB64url(crypto.getRandomValues(new Uint8Array(16))) } };
}

async function vapidEnv() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
  return {
    VAPID_PUBLIC: bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))),
    VAPID_PRIVATE: bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))),
  };
}

/** Мок D1: отдаёт заданные строки на SELECT по reminders / push_subs,
 *  записывает все выражения с параметрами. */
function makeDb(tables: { reminders?: object[]; push_subs?: object[] } = {}) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const result = (sql: string, args: unknown[]) => ({
    async run() {
      calls.push({ sql, args });
      return { meta: { changes: 1 } };
    },
    async all() {
      calls.push({ sql, args });
      if (sql.includes('FROM reminders')) return { results: tables.reminders ?? [] };
      if (sql.includes('FROM push_subs')) return { results: tables.push_subs ?? [] };
      return { results: [] };
    },
    async first() {
      calls.push({ sql, args });
      return null;
    },
  });
  return {
    calls,
    prepare(sql: string) {
      return { ...result(sql, []), bind: (...args: unknown[]) => result(sql, args) };
    },
  };
}

/** Подставной интернет: «tarpit» принимает соединение и молчит, пока запрос
 *  не оборвут; остальные push-службы отвечают 201. Сторож версии (github.io)
 *  получает 404 и ничего не делает. */
function stubNetwork() {
  const hits: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    hits.push(url);
    if (url.includes('tarpit')) {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    return Promise.resolve(new Response(null, { status: url.startsWith(ORIGIN) ? 404 : 201 }));
  });
  // Настоящий срок — 10 с; в тесте ждать его незачем: важно, что он передан.
  const asked: number[] = [];
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    asked.push(ms);
    return realTimeout(20);
  });
  return { hits, asked };
}

/** Дождаться всех waitUntil, но не дольше limitMs: зависший цикл до правки
 *  иначе повесил бы весь прогон. */
async function settle(promises: Promise<unknown>[], limitMs = 1500) {
  await Promise.race([Promise.allSettled(promises), new Promise((r) => setTimeout(r, limitMs))]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('крон напоминаний: зависший адрес не держит очередь (NEW-S-1)', () => {
  it('молчащий push-адрес обрывается по сроку, следующее напоминание уходит, обе строки сняты', async () => {
    const { hits, asked } = stubNetwork();
    const db = makeDb({
      reminders: [
        { task_id: 'TARPIT', fire_at: 0, title: '', body: '', subscription: JSON.stringify(await subscription('https://fcm.googleapis.com/fcm/send/tarpit')) },
        { task_id: 'REAL', fire_at: 1, title: '', body: '', subscription: JSON.stringify(await subscription('https://web.push.apple.com/real')) },
      ],
    });
    const waits: Promise<unknown>[] = [];
    await worker.scheduled({}, { DB: db, ...(await vapidEnv()) }, { waitUntil: (p) => void waits.push(p) });
    await settle(waits);

    expect(hits).toContain('https://web.push.apple.com/real');
    expect(asked).toContain(10_000);
    const deleted = db.calls.filter((c) => c.sql.startsWith('DELETE FROM reminders')).map((c) => c.args[0]);
    expect(deleted).toEqual(['TARPIT', 'REAL']);
  });
});

describe('рассылка «вышло обновление»: зависший адрес не глушит остальных (NEW-S-1)', () => {
  it('молчащая подписка обрывается по сроку, живая получает пуш', async () => {
    const { hits, asked } = stubNetwork();
    const tarpit = await subscription('https://fcm.googleapis.com/fcm/send/tarpit');
    const real = await subscription('https://updates.push.services.mozilla.com/wpush/v2/real');
    const db = makeDb({
      push_subs: [
        { endpoint: tarpit.endpoint, sub: JSON.stringify(tarpit) },
        { endpoint: real.endpoint, sub: JSON.stringify(real) },
      ],
    });
    const kv = new Map<string, string>();
    const env = {
      ALLOW_ORIGIN: ORIGIN,
      UPDATE_TOKEN: 'secret',
      DB: db,
      REMINDERS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) },
      ...(await vapidEnv()),
    };
    const req = new Request('https://w.test/notify-update', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'Текст' }),
    });
    const res = await Promise.race([
      worker.fetch(req, env, { waitUntil() {} }),
      new Promise<null>((r) => setTimeout(() => r(null), 1500)),
    ]);
    expect(res, 'рассылка зависла на молчащем адресе').not.toBeNull();
    expect(await res!.json()).toMatchObject({ ok: true, sent: 1 });
    expect(hits).toContain(real.endpoint);
    expect(asked).toContain(10_000);
  });
});
