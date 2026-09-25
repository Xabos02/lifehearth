// Сервер хранит текст напоминания только шифротекстом (решение 24.09:
// «всё защищено»). Проверяется ровно то, что уходит в D1, и SQL-чистка старых
// записей — на настоящем SQLite (node:sqlite, как в familyRoom.test.ts).
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { SCRUB_PLAIN_REMINDERS_SQL, storableReminderText } from './src/reminderText.js';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const worker = (await import('./src/index.js')).default as {
  fetch: (r: Request, e: unknown, c: unknown) => Promise<Response>;
  scheduled: (ev: unknown, e: unknown, c: { waitUntil: (p: Promise<unknown>) => void }) => Promise<void>;
};

/** D1 поверх настоящего SQLite: prepare(sql).bind(...).run()/all()/first(). */
function d1(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    run: async () => (db.prepare(sql).run(...(args as never[])), {}),
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
  });
  return { prepare: (sql: string) => stmt(sql) };
}

function remindersDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE reminders (task_id TEXT PRIMARY KEY, fire_at INTEGER, title TEXT, body TEXT, subscription TEXT)');
  db.exec('CREATE TABLE app_meta (k TEXT PRIMARY KEY, v TEXT)');
  return db;
}

describe('текст напоминания на сервере', () => {
  it('шифротекст хранится как есть, открытый текст — нет', () => {
    expect(storableReminderText('', 'e2e1:abc')).toEqual({ title: '', body: 'e2e1:abc' });
    expect(storableReminderText('Забрать анализы', 'Через 30 мин')).toEqual({ title: '', body: '' });
    expect(storableReminderText(undefined, undefined)).toEqual({ title: '', body: '' });
  });

  it('чистка стирает открытый текст старых записей и не трогает шифротекст', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE reminders (task_id TEXT PRIMARY KEY, fire_at INTEGER, title TEXT, body TEXT, subscription TEXT)');
    const ins = db.prepare('INSERT INTO reminders VALUES (?, ?, ?, ?, ?)');
    ins.run('old', 1, 'Забрать анализы', 'Через 30 мин', '{}');
    ins.run('new', 1, '', 'e2e1:abc', '{}');
    db.exec(SCRUB_PLAIN_REMINDERS_SQL);
    const rows = db.prepare('SELECT task_id, title, body FROM reminders ORDER BY task_id').all();
    expect(rows).toEqual([
      { task_id: 'new', title: '', body: 'e2e1:abc' },
      { task_id: 'old', title: '', body: '' },
    ]);
  });

  // Сторож подключения: функции выше верны, но важно, что /schedule и крон
  // ими пользуются, — иначе рефакторинг молча вернёт открытый текст в D1.
  it('/schedule кладёт в D1 шифротекст как есть, а открытый текст — пустым', async () => {
    const db = remindersDb();
    const post = (taskId: string, title: string, body: string) =>
      worker.fetch(
        new Request('https://w.test/schedule', {
          method: 'POST',
          body: JSON.stringify({ taskId, fireAt: 1e13, title, body, subscription: { endpoint: 'https://push.test/1' } }),
        }),
        { DB: d1(db) },
        { waitUntil() {} },
      );
    expect((await post('plain', 'Забрать анализы', 'Через 30 мин')).status).toBe(200);
    expect((await post('sealed', '', 'e2e1:abc')).status).toBe(200);
    expect(db.prepare('SELECT task_id, title, body FROM reminders ORDER BY task_id').all()).toEqual([
      { task_id: 'plain', title: '', body: '' },
      { task_id: 'sealed', title: '', body: 'e2e1:abc' },
    ]);
  });

  it('крон стирает открытый текст, оставшийся с прежних версий', async () => {
    const db = remindersDb();
    db.prepare('INSERT INTO reminders VALUES (?, ?, ?, ?, ?)').run('old', 1e13, 'Забрать анализы', 'Через 30 мин', '{}');
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    const waits: Promise<unknown>[] = [];
    try {
      await worker.scheduled({}, { DB: d1(db) }, { waitUntil: (p) => void waits.push(p) });
      await Promise.all(waits);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(db.prepare('SELECT title, body FROM reminders').all()).toEqual([{ title: '', body: '' }]);
  });
});
