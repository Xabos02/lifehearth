// SyncHub — сигнал «есть чужие правки» устройствам одного аккаунта.
//
// Durable Object целиком в Node не поднять: подменяются базовый класс,
// хранилище (Map) и список сокетов. Сам syncHub.js импортируется как есть.
// Открытие сокета (101 + WebSocketPair) вне Workers невоспроизводимо — эта
// ветка проверяется живым `wrangler dev`, здесь — всё вокруг неё: выдача и
// одноразовость тикета, отказы, рассылка.

import { describe, expect, it, vi } from 'vitest';

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

const { SyncHub } = await import('./src/syncHub.js');

function makeHub() {
  const store = new Map<string, unknown>();
  const sockets: { sent: string[]; send: (f: string) => void }[] = [];
  const ctx = {
    storage: {
      async get(k: string) {
        return store.get(k);
      },
      async put(k: string, v: unknown) {
        store.set(k, v);
      },
      async delete(k: string | string[]) {
        for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
      },
      async list({ prefix }: { prefix: string }) {
        return new Map([...store.entries()].filter(([k]) => k.startsWith(prefix)));
      },
    },
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
  };
  const hub = new SyncHub(ctx, {});
  const addSocket = () => {
    const s = { sent: [] as string[], send: (f: string) => s.sent.push(f) };
    sockets.push(s);
    return s;
  };
  const call = (path: string, init: RequestInit = {}) => hub.fetch(new Request(`https://hub${path}`, init));
  return { hub, store, call, addSocket };
}

describe('SyncHub: тикеты', () => {
  it('тикет выдаётся и хранится с временем жизни', async () => {
    const h = makeHub();
    const res = await h.call('/sync/ticket', { method: 'POST' });
    expect(res.status).toBe(200);
    const { ticket } = (await res.json()) as { ticket: string };
    expect(ticket).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(h.store.get(`ticket:${ticket}`))).toBeGreaterThan(Date.now());
  });

  it('просроченные тикеты чистятся при выдаче следующего', async () => {
    const h = makeHub();
    h.store.set('ticket:old', Date.now() - 1);
    await h.call('/sync/ticket', { method: 'POST' });
    expect(h.store.has('ticket:old')).toBe(false);
  });

  it('сокет без Upgrade — 426, с чужим или просроченным тикетом — 401', async () => {
    const h = makeHub();
    expect((await h.call('/sync/ws?ticket=x')).status).toBe(426);
    const ws = { headers: { Upgrade: 'websocket' } };
    expect((await h.call('/sync/ws?ticket=nope', ws)).status).toBe(401);
    h.store.set('ticket:late', Date.now() - 1);
    expect((await h.call('/sync/ws?ticket=late', ws)).status).toBe(401);
    // Просроченный тикет при этом снят — не копится.
    expect(h.store.has('ticket:late')).toBe(false);
  });

  it('тикет одноразовый: снимается при первом же предъявлении', async () => {
    const h = makeHub();
    h.store.set('ticket:t1', Date.now() + 60_000);
    // Вне Workers открыть сокет нельзя (нет WebSocketPair) — ветка падает уже
    // ПОСЛЕ проверки тикета, и это ровно то, что здесь важно: тикет снят.
    await h.call('/sync/ws?ticket=t1', { headers: { Upgrade: 'websocket' } }).catch(() => null);
    expect(h.store.has('ticket:t1')).toBe(false);
    const again = await h.call('/sync/ws?ticket=t1', { headers: { Upgrade: 'websocket' } });
    expect(again.status).toBe(401);
  });
});

describe('SyncHub: рассылка', () => {
  it('«changed» уходит во все сокеты с именем устройства-автора', async () => {
    const h = makeHub();
    const a = h.addSocket();
    const b = h.addSocket();
    const res = await h.call('/sync/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'dev-phone' }),
    });
    expect(((await res.json()) as { delivered: number }).delivered).toBe(2);
    expect(JSON.parse(a.sent[0])).toEqual({ type: 'changed', by: 'dev-phone' });
    expect(JSON.parse(b.sent[0])).toEqual({ type: 'changed', by: 'dev-phone' });
  });

  it('закрывающийся сокет не срывает рассылку остальным', async () => {
    const h = makeHub();
    const dead = h.addSocket();
    dead.send = () => {
      throw new Error('closing');
    };
    const alive = h.addSocket();
    const res = await h.call('/sync/notify', { method: 'POST', body: '{"by":"x"}' });
    expect(((await res.json()) as { delivered: number }).delivered).toBe(1);
    expect(alive.sent).toHaveLength(1);
  });

  it('без тела рассылка всё равно идёт — автор просто не назван', async () => {
    const h = makeHub();
    const s = h.addSocket();
    await h.call('/sync/notify', { method: 'POST' });
    expect(JSON.parse(s.sent[0])).toEqual({ type: 'changed', by: '' });
  });
});
