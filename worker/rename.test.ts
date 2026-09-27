// Перенос открытых id под непрозрачные (задача 35): /sync/rename и флаг
// plainIds в /sync/pull. На настоящем SQLite (node:sqlite) со схемой из
// migrations — проверяется именно SQL сервера, а не мок: это первое место,
// где воркер удаляет записи синка, и ошибка здесь — потерянные данные.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const worker = (await import('./src/index.js')).default as {
  fetch: (r: Request, e: unknown, c: unknown) => Promise<Response>;
};

type Row = Record<string, unknown>;

/** D1 поверх SQLite: prepare(sql).bind(...).run()/all()/first(), batch — одной транзакцией. */
function d1(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) as Row[] }),
    first: async () => (db.prepare(sql).get(...(args as never[])) as Row | undefined) ?? null,
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: ReturnType<typeof stmt>[]) => {
      db.exec('BEGIN');
      try {
        const out = list.map((s) => ({ meta: { changes: Number(db.prepare(s.sql).run(...(s.args as never[])).changes) } }));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function server() {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_init.sql', '0006_records_pull_id.sql', '0007_records_seq.sql']) {
    db.exec(readFileSync(new URL(`./migrations/${f}`, import.meta.url), 'utf8'));
  }
  const env = { DB: d1(db) };
  const call = async (path: string, body?: unknown, account = 'acc-A', method = body ? 'POST' : 'GET') => {
    const res = await worker.fetch(
      new Request(`https://w.test${path}`, {
        method,
        headers: { 'X-Account': account, Authorization: `Bearer tok-${account}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
      { waitUntil() {} },
    );
    return { status: res.status, data: (await res.json()) as Row };
  };
  const push = (table: string, id: string, updatedAt: string, ciphertext: string, device = 'dev-old', account = 'acc-A') =>
    call('/sync/push', { records: [{ table, id, updatedAt, deletedAt: null, ciphertext }], device }, account);
  const rows = (account = 'acc-A') =>
    db.prepare('SELECT table_name t, id, updated_at u, ciphertext c, seq FROM records WHERE account_id = ? ORDER BY t, id').all(account) as Row[];
  const full = (account = 'acc-A') =>
    db.prepare('SELECT table_name t, id, deleted_at d, device_id dev FROM records WHERE account_id = ? ORDER BY t, id').all(account) as Row[];
  const pushDel = (table: string, id: string, updatedAt: string, device: string) =>
    call('/sync/push', { records: [{ table, id, updatedAt, deletedAt: updatedAt, ciphertext: 'tomb' }], device });
  return { call, push, rows, full, pushDel };
}

const TO = 'abhLFfdnWe1YklNS0RudOg'; // 22 символа base64url, как HMAC на проводе

describe('перенос открытых id (/sync/rename)', () => {
  it('двойника нет — открытая строка встаёт под непрозрачным id и исчезает', async () => {
    const s = server();
    await s.push('metricLogs', 'health:weight:2026-09-25', '2026-09-25T10:00:00.000Z', 'ct-open');
    const r = await s.call('/sync/rename', { rename: [{ table: 'metricLogs', id: 'health:weight:2026-09-25', to: TO }] });
    expect(r.data).toEqual({ ok: true, ids: [] });
    expect(s.rows()).toEqual([{ t: 'metricLogs2', id: TO, u: '2026-09-25T10:00:00.000Z', c: 'ct-open', seq: 1 }]);
  });

  it('открытая новее двойника — остаётся её версия; двойник новее — его', async () => {
    const s = server();
    // Двойника прислало новое устройство в 09:00, а старое устройство потом — открытую правку в 10:00.
    await s.push('metricLogs2', TO, '2026-09-25T09:00:00.000Z', 'twin-09', 'dev-new');
    await s.push('metricLogs', 'h:w', '2026-09-25T10:00:00.000Z', 'open-10');
    await s.call('/sync/rename', { rename: [{ table: 'metricLogs', id: 'h:w', to: TO }] });
    expect(s.rows()).toEqual([{ t: 'metricLogs2', id: TO, u: '2026-09-25T10:00:00.000Z', c: 'open-10', seq: 2 }]);

    const t = server();
    await t.push('metricLogs2', TO, '2026-09-25T11:00:00.000Z', 'twin-11', 'dev-new');
    await t.push('metricLogs', 'h:w', '2026-09-25T10:00:00.000Z', 'open-10');
    await t.call('/sync/rename', { rename: [{ table: 'metricLogs', id: 'h:w', to: TO }] });
    // Свежее — двойник, но seq забирает больший (у открытой): номер не повторится.
    expect(t.rows()).toEqual([{ t: 'metricLogs2', id: TO, u: '2026-09-25T11:00:00.000Z', c: 'twin-11', seq: 2 }]);
    await t.push('tasks', 't1', '2026-09-25T12:00:00.000Z', 'task');
    expect(t.rows().find((r) => r.id === 't1')?.seq).toBe(3);
  });

  it('равные метки — двойник остаётся; повтор переноса ничего не меняет', async () => {
    const s = server();
    await s.push('metricLogs', 'h:w', '2026-09-25T10:00:00.000Z', 'open');
    await s.push('metricLogs2', TO, '2026-09-25T10:00:00.000Z', 'twin', 'dev-new');
    const pair = { rename: [{ table: 'metricLogs', id: 'h:w', to: TO }] };
    await s.call('/sync/rename', pair);
    await s.call('/sync/rename', pair);
    expect(s.rows()).toEqual([{ t: 'metricLogs2', id: TO, u: '2026-09-25T10:00:00.000Z', c: 'twin', seq: 2 }]);
  });

  it('чужой аккаунт, таблицы вне списка и кривой id не трогаются', async () => {
    const s = server();
    await s.push('metricLogs', 'h:w', '2026-09-25T10:00:00.000Z', 'mine');
    await s.push('metricLogs', 'h:w', '2026-09-25T10:00:00.000Z', 'theirs', 'dev-b', 'acc-B');
    await s.push('tasks', 't1', '2026-09-25T10:00:00.000Z', 'task');
    const r = await s.call('/sync/rename', {
      rename: [
        { table: 'tasks', id: 't1', to: TO },
        { table: 'metricLogs', id: 'h:w', to: 'не-то' },
        { table: 'constructor', id: 'x', to: TO },
      ],
    });
    expect(r.data).toEqual({ ok: true, ids: [{ table: 'metricLogs', id: 'h:w' }] });
    expect(s.rows().map((x) => `${x.t}/${x.id}`)).toEqual(['metricLogs/h:w', 'tasks/t1']);
    expect(s.rows('acc-B').map((x) => `${x.t}/${x.id}`)).toEqual(['metricLogs/h:w']);
  });

  it('двойник новее — остаётся и его автор: устройство-автор открытой строки получит двойника', async () => {
    // Иначе перенос приписал бы строку автору открытой, и фильтр «свои не
    // отдаём» навсегда спрятал бы от него более свежую версию.
    const s = server();
    await s.push('metricLogs2', TO, '2026-09-25T11:00:00.000Z', 'twin-11', 'dev-new');
    await s.push('metricLogs', 'h:w', '2026-09-25T10:00:00.000Z', 'open-10', 'dev-old');
    await s.call('/sync/rename', { rename: [{ table: 'metricLogs', id: 'h:w', to: TO }] });
    expect(s.full()).toEqual([{ t: 'metricLogs2', id: TO, d: null, dev: 'dev-new' }]);
    const got = await s.call('/sync/pull?after=0&device=dev-old');
    expect((got.data.records as Row[]).map((r) => r.ciphertext)).toEqual(['twin-11']);
  });

  it('надгробие новее живого двойника — удаление переносится, а не воскресает', async () => {
    const s = server();
    await s.push('metricLogs2', TO, '2026-09-25T09:00:00.000Z', 'twin-09', 'dev-new');
    await s.pushDel('metricLogs', 'h:w', '2026-09-25T10:00:00.000Z', 'dev-old');
    await s.call('/sync/rename', { rename: [{ table: 'metricLogs', id: 'h:w', to: TO }] });
    expect(s.full()).toEqual([{ t: 'metricLogs2', id: TO, d: '2026-09-25T10:00:00.000Z', dev: 'dev-old' }]);
  });

  it('без токена — 401', async () => {
    const res = await worker.fetch(new Request('https://w.test/sync/rename', { method: 'POST', body: '{}' }), { DB: {} }, { waitUntil() {} });
    expect(res.status).toBe(401);
  });
});

describe('флаг plainIds в /sync/pull', () => {
  it('есть, пока остались открытые строки, и пропадает после переноса', async () => {
    const s = server();
    await s.push('metricLogs', 'h:w', '2026-09-25T10:00:00.000Z', 'open');
    expect((await s.call('/sync/pull?after=0&device=dev-new')).data.plainIds).toBe(true);
    await s.call('/sync/rename', { rename: [{ table: 'metricLogs', id: 'h:w', to: TO }] });
    expect((await s.call('/sync/pull?after=0&device=dev-new')).data.plainIds).toBeUndefined();
  });

  it('обычные таблицы флаг не зажигают', async () => {
    const s = server();
    await s.push('tasks', 't1', '2026-09-25T10:00:00.000Z', 'task');
    expect((await s.call('/sync/pull?after=0')).data.plainIds).toBeUndefined();
  });
});
