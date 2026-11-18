// Пределы сервера против постороннего (аудит 1.64.0, S4).
//
// Как это ломалось. Аккаунт заводил кто угодно: любой новый X-Account с любым
// токеном — и строка в accounts готова. Потолков не было: /sync/push принимал
// 20 000 записей одним запросом, /backup/put — куски с любыми номерами, а
// /schedule — тело любого размера без всякой учётки. Нескольких запросов
// хватало, чтобы выбрать суточную квоту записи D1 или забить базу, и тогда у
// всей семьи вставали обмен, копия и напоминания.

import { describe, expect, it, vi } from 'vitest';
import { d1, sqliteDb } from './d1Sqlite';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const worker = (await import('./src/index.js')).default as {
  fetch: (r: Request, e: unknown, c: unknown) => Promise<Response>;
};

function server() {
  const db = sqliteDb();
  const env = { DB: d1(db) };
  const call = async (path: string, body: unknown, opts: { account?: string; ip?: string; raw?: string } = {}) => {
    const res = await worker.fetch(
      new Request(`https://w.test${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': opts.ip ?? '203.0.113.7',
          ...(opts.account ? { 'X-Account': opts.account, Authorization: `Bearer tok-${opts.account}` } : {}),
        },
        body: opts.raw ?? JSON.stringify(body),
      }),
      env,
      { waitUntil() {} },
    );
    return res.status;
  };
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return { db, call, count };
}

const rec = (i: number, ciphertext = 'ct') => ({ table: 'tasks', id: `id${i}`, updatedAt: '2026-11-18T10:00:00.000Z', deletedAt: null, ciphertext });

describe('заведение аккаунтов: не больше 10 в час с одного адреса (S4)', () => {
  it('11-й новый аккаунт с того же адреса — 429 и строки нет; старые аккаунты и другой адрес работают', async () => {
    const s = server();
    for (let i = 0; i < 10; i++) expect(await s.call('/sync/push', { records: [] }, { account: `acc-${i}` })).toBe(200);
    expect(await s.call('/sync/push', { records: [] }, { account: 'acc-extra' })).toBe(429);
    expect(s.count("SELECT COUNT(*) n FROM accounts WHERE account_id = 'acc-extra'")).toBe(0);
    // Уже заведённый аккаунт пределом не задевается.
    expect(await s.call('/sync/push', { records: [rec(1)] }, { account: 'acc-3' })).toBe(200);
    // Другой адрес — свой счётчик.
    expect(await s.call('/sync/push', { records: [] }, { account: 'acc-extra', ip: '198.51.100.2' })).toBe(200);
  });

  it('IPv6: адреса одной сети /64 считаются как один', async () => {
    const s = server();
    for (let i = 0; i < 10; i++) {
      expect(await s.call('/sync/push', { records: [] }, { account: `v6-${i}`, ip: `2001:db8:1:2::${i + 1}` })).toBe(200);
    }
    expect(await s.call('/sync/push', { records: [] }, { account: 'v6-x', ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' })).toBe(429);
    expect(await s.call('/sync/push', { records: [] }, { account: 'v6-y', ip: '2001:db8:1:3::1' })).toBe(200);
  });
});

describe('/schedule: не больше 200 в час с одного адреса и тело не больше 16 КБ (S4, S5)', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } };
  it('201-е напоминание за час — 429, строки нет', async () => {
    const s = server();
    const fireAt = Date.now() + 60_000;
    for (let i = 0; i < 200; i++) expect(await s.call('/schedule', { taskId: `t${i}`, fireAt, subscription: sub })).toBe(200);
    expect(await s.call('/schedule', { taskId: 'extra', fireAt, subscription: sub })).toBe(429);
    expect(s.count('SELECT COUNT(*) n FROM reminders')).toBe(200);
  });

  it('тело больше 16 КБ — 413: такой пуш всё равно не доставить (потолок Web Push — 4 КБ)', async () => {
    const s = server();
    const body = { taskId: 't', fireAt: Date.now() + 60_000, title: '', body: `e2e1:${'A'.repeat(20_000)}`, subscription: sub };
    expect(await s.call('/schedule', body)).toBe(413);
    expect(s.count('SELECT COUNT(*) n FROM reminders')).toBe(0);
  });
});

describe('/sync/push: не больше 500 записей и 4 МиБ за запрос (S4)', () => {
  it('501 запись — 413 и ничего не записано; 500 — принято', async () => {
    const s = server();
    const many = (n: number) => Array.from({ length: n }, (_, i) => rec(i));
    expect(await s.call('/sync/push', { records: many(501) }, { account: 'acc-A' })).toBe(413);
    expect(s.count('SELECT COUNT(*) n FROM records')).toBe(0);
    expect(await s.call('/sync/push', { records: many(500) }, { account: 'acc-A' })).toBe(200);
    expect(s.count('SELECT COUNT(*) n FROM records')).toBe(500);
  });

  it('тело больше 4 МиБ — 413, ничего не записано', async () => {
    const s = server();
    const big = [rec(1, 'x'.repeat(2_200_000)), rec(2, 'y'.repeat(2_200_000))];
    expect(await s.call('/sync/push', { records: big }, { account: 'acc-A' })).toBe(413);
    expect(s.count('SELECT COUNT(*) n FROM records')).toBe(0);
  });
});

describe('/backup/put: номера кусков только 0..total-1, total не больше 100 (S4)', () => {
  it('куски вне диапазона не пишутся; total больше 100 или дробный — 400', async () => {
    const s = server();
    const chunks = [-1, 0, 1, 2, 1e9, 0.5].map((chunk) => ({ chunk, ciphertext: `c${chunk}` }));
    expect(await s.call('/backup/put', { chunks, total: 2 }, { account: 'acc-A' })).toBe(200);
    expect(s.db.prepare('SELECT chunk FROM backups ORDER BY chunk').all()).toEqual([{ chunk: 0 }, { chunk: 1 }]);

    expect(await s.call('/backup/put', { chunks: [], total: 101 }, { account: 'acc-A' })).toBe(400);
    expect(await s.call('/backup/put', { chunks: [], total: 1.5 }, { account: 'acc-A' })).toBe(400);
    expect(s.count('SELECT COUNT(*) n FROM backups')).toBe(2);
  });
});
