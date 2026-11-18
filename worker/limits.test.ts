// Ограничения нагрузки (limits.js): регистрация аккаунтов, ИИ, адреса push,
// частотный лимитер. Все суточные счётчики — в настоящем SQLite (node:sqlite),
// чтобы проверялся сам SQL, а не мок.

import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const worker = await import('./src/index.js');
const ORIGIN = 'https://xabos02.github.io';
const GEMMA = '@cf/google/gemma-4-26b-a4b-it';

/** Минимальная D1 поверх node:sqlite. */
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE accounts (account_id TEXT PRIMARY KEY, token_hash TEXT, created_at TEXT)');
  // Схему счётчиков воркер заводит лениво раз на изолят — в тестах база
  // каждый раз новая, поэтому таблица создаётся здесь.
  db.exec('CREATE TABLE usage_counters (k TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (k, day))');
  db.exec('CREATE TABLE reminders (task_id TEXT PRIMARY KEY, fire_at INTEGER, title TEXT, body TEXT, subscription TEXT)');
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    run: async () => {
      const r = db.prepare(sql).run(...(args as never[]));
      return { meta: { changes: Number(r.changes) } };
    },
  });
  return { db, DB: { prepare: (sql: string) => stmt(sql) } };
}

function req(path: string, init: { ip?: string; account?: string; token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { Origin: ORIGIN, 'CF-Connecting-IP': init.ip ?? '203.0.113.7' };
  if (init.account) headers['X-Account'] = init.account;
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  return new Request(`https://w.test${path}`, {
    method: init.body !== undefined ? 'POST' : 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const call = (r: Request, env: Record<string, unknown>) =>
  worker.default.fetch(r, { ALLOW_ORIGIN: ORIGIN, ...env }, { waitUntil() {} });

describe('лимиты сервера', () => {
  it('с одного адреса — не больше NEW_ACCOUNTS_PER_IP_DAY новых аккаунтов в сутки, 429 а не 401', async () => {
    const { DB, db } = d1();
    const env = { DB, NEW_ACCOUNTS_PER_IP_DAY: '2' };
    const pull = (acc: string, ip?: string) =>
      call(req('/sync/pull', { account: acc, token: `tok-${acc}`, ip }), env).then((r) => r.status);
    // pull без after идёт по старому курсору — records таблицы нет, но
    // регистрация происходит раньше: смотрим на таблицу accounts.
    db.exec('CREATE TABLE records (account_id TEXT, table_name TEXT, id TEXT, updated_at TEXT, deleted_at TEXT, ciphertext TEXT)');
    expect(await pull('a1')).toBe(200);
    expect(await pull('a2')).toBe(200);
    expect(await pull('a3')).toBe(429);
    // Уже заведённый аккаунт пускается и сверх потолка.
    expect(await pull('a1')).toBe(200);
    // Другой адрес — свой счётчик.
    expect(await pull('a3', '198.51.100.1')).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 3 });
    // IP открытым текстом не хранится.
    const keys = db.prepare('SELECT k FROM usage_counters').all() as { k: string }[];
    expect(keys.some((r) => r.k.includes('203.0.113.7'))).toBe(false);
  });

  it('ИИ: суточный потолок на аккаунт → 429 user_quota; аккаунт из AI_ALLOWED_ACCOUNTS без потолка', async () => {
    const { DB } = d1();
    const run = vi.fn(async () => new Response('data: [DONE]\n\n').body);
    const env = { DB, AI: { run }, AI_CALLS_PER_ACCOUNT_DAY: '2', AI_ALLOWED_ACCOUNTS: 'owner' };
    const ask = (acc: string, ip?: string) =>
      call(req('/ai/chat', { account: acc, token: `tok-${acc}`, ip, body: { model: GEMMA, messages: [{ role: 'user', content: 'hi' }] } }), env);
    expect((await ask('u1')).status).toBe(200);
    expect((await ask('u1')).status).toBe(200);
    const third = await ask('u1');
    expect(third.status).toBe(429);
    expect((await third.json()).error).toBe('user_quota');
    expect(run).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 4; i++) expect((await ask('owner')).status).toBe(200);
  });

  it('ИИ: потолок на адрес не обходится новыми аккаунтами', async () => {
    const { DB } = d1();
    const run = vi.fn(async () => new Response('data: [DONE]\n\n').body);
    const env = { DB, AI: { run }, AI_CALLS_PER_IP_DAY: '3' };
    const ask = (acc: string) =>
      call(req('/ai/chat', { account: acc, token: `tok-${acc}`, body: { model: GEMMA, messages: [{ role: 'user', content: 'hi' }] } }), env);
    const codes = [];
    for (const acc of ['x1', 'x2', 'x3', 'x4']) codes.push((await ask(acc)).status);
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it('частотный лимитер: отказ биндинга → 429, его сбой запрос не роняет', async () => {
    const { DB } = d1();
    const deny = { limit: async () => ({ success: false }) };
    expect((await call(req('/sync/pull', { account: 'a', token: 't' }), { DB, RL_IP: deny })).status).toBe(429);
    const broken = { limit: async () => { throw new Error('down'); } };
    expect((await call(req('/health'), { DB, RL_IP: broken })).status).toBe(200);
    expect((await call(req('/account/check', { account: 'a', token: 't' }), { DB, RL_IP: broken })).status).toBe(200);
  });

  it('/schedule принимает только адреса push-служб и разумный срок', async () => {
    const { DB } = d1();
    const post = (endpoint: string, fireAt = Date.now() + 60_000) =>
      call(req('/schedule', { body: { taskId: 't1', fireAt, title: '', body: 'e2e1:x', subscription: { endpoint } } }), { DB }).then(
        (r) => r.status,
      );
    expect(await post('https://fcm.googleapis.com/fcm/send/abc')).toBe(200);
    expect(await post('https://web.push.apple.com/QF')).toBe(200);
    expect(await post('https://db5p.notify.windows.com/w/?token=1')).toBe(200);
    expect(await post('https://evil.example/hook')).toBe(400);
    expect(await post('http://fcm.googleapis.com/x')).toBe(400);
    expect(await post('https://fcm.googleapis.com.evil.example/x')).toBe(400);
    expect(await post('https://fcm.googleapis.com/x', Date.now() + 500 * 86_400_000)).toBe(400);
    expect(
      (await call(req('/push-register', { body: { subscription: { endpoint: 'https://evil.example/' } } }), { DB })).status,
    ).toBe(400);
  });

  it('/sync/push: пачка больше 1000 записей — 413', async () => {
    const { DB } = d1();
    const records = Array.from({ length: 1001 }, (_, i) => ({ table: 'tasks', id: `i${i}`, updatedAt: 'x', ciphertext: 'c' }));
    const res = await call(req('/sync/push', { account: 'big', token: 'tok-big', body: { records } }), { DB });
    expect(res.status).toBe(413);
  });
});
