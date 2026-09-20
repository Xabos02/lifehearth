// Составной курсор /sync/pull: "updatedAt|id" вместо одного updatedAt.
//
// Дефект, который это закрывает: сортировка страницы идёт по (updated_at, id),
// а курсор двигался только по updated_at. Записи с одинаковым миллисекундным
// штампом, не поместившиеся на страницу, терялись навсегда — следующий запрос
// просил строго больше этого значения. На сервере всё цело, на устройстве
// записей нет, причина ниоткуда не видна.

import { describe, expect, it, vi } from 'vitest';

// index.js реэкспортирует FamilyRoom, а тот тянет модуль, которого вне Workers
// не существует. Сам Durable Object здесь не нужен.
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

const worker = await import('./src/index.js');

const ORIGIN = 'https://xabos02.github.io';

interface PullRow {
  tbl: string;
  id: string;
  u: string;
  d: string | null;
  c: string;
}

/** Мок D1: авторизация проходит по TOFU (аккаунт не найден → регистрируется),
 *  выборка pull отдаёт заготовленные строки и записывает связанные параметры,
 *  пачка push запоминает SQL и параметры каждого выражения. Проба колонок
 *  seq/device_id (ленивая миграция) отвечает «есть», если не сказано иначе;
 *  DDL записывается в ddl. changes — сколько строк «записала» каждая вставка. */
function makeDb(rows: PullRow[], opts: { hasColumns?: boolean; changes?: number; ddlWorks?: boolean } = {}) {
  const pullBinds: unknown[][] = [];
  const pullSql: string[] = [];
  const pushBinds: unknown[][] = [];
  const pushSql: string[] = [];
  const ddl: string[] = [];
  let probes = 0;
  let hasColumns = opts.hasColumns ?? true;
  // ddlWorks=false — ALTER «проходит», но колонки не появляются: так выглядит
  // проба, упавшая по другой причине (D1 недоступна), а не из-за колонок.
  const ddlWorks = opts.ddlWorks ?? true;
  const changes = opts.changes ?? 1;
  const statement = (sql: string, args: unknown[]) => ({
    sql,
    args,
    async first() {
      return null; // accounts: не найден → TOFU-регистрация
    },
    async run() {
      if (/^(ALTER|CREATE|UPDATE|INSERT OR IGNORE)/.test(sql)) ddl.push(sql);
      return {}; // INSERT INTO accounts и прочее
    },
    async all() {
      if (sql.includes('LIMIT 0')) {
        probes++;
        if (!hasColumns) throw new Error('no such column: seq');
        return { results: [] };
      }
      if (!sql.includes('FROM records')) throw new Error(`неожиданный all(): ${sql}`);
      pullSql.push(sql);
      pullBinds.push(args);
      return { results: rows };
    },
  });
  return {
    pullBinds,
    pullSql,
    pushBinds,
    pushSql,
    ddl,
    get probes() {
      return probes;
    },
    prepare(sql: string) {
      return { ...statement(sql, []), bind: (...args: unknown[]) => statement(sql, args) };
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      const out: { meta: { changes: number } }[] = [];
      for (const st of stmts) {
        if (/^\s*(ALTER|CREATE|UPDATE records SET seq = rowid)/.test(st.sql)) {
          ddl.push(st.sql);
          if (st.sql.includes('ADD COLUMN seq') && ddlWorks) hasColumns = true;
          out.push({ meta: { changes: 0 } });
          continue;
        }
        pushSql.push(st.sql);
        pushBinds.push(st.args);
        out.push({ meta: { changes: st.sql.startsWith('UPDATE') ? 0 : changes } });
      }
      return out;
    },
  };
}

/** Подставной SyncHub: записывает, кого и с чем разбудили. */
function makeHub() {
  const calls: { path: string; body: unknown }[] = [];
  const names: string[] = [];
  return {
    calls,
    names,
    idFromName(name: string) {
      names.push(name);
      return name;
    },
    get() {
      return {
        async fetch(url: string, init?: RequestInit) {
          calls.push({ path: new URL(url).pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
          return new Response('{"ok":true}', { status: 200 });
        },
      };
    },
  };
}

async function pull(db: ReturnType<typeof makeDb>, since: string) {
  return worker.default.fetch(
    new Request(`https://life-hub-push.workers.dev/sync/pull?since=${encodeURIComponent(since)}`, {
      headers: {
        Origin: ORIGIN,
        'X-Account': 'acc-1',
        Authorization: 'Bearer tok-1',
      },
    }),
    { ALLOW_ORIGIN: ORIGIN, DB: db },
    { waitUntil: () => {} },
  );
}

/** Приём по порядку прихода: курсор `after`, устройство — в строке запроса. */
async function pullAfter(db: ReturnType<typeof makeDb>, after: string, device?: string) {
  const q = `after=${encodeURIComponent(after)}${device ? `&device=${encodeURIComponent(device)}` : ''}`;
  return worker.default.fetch(
    new Request(`https://life-hub-push.workers.dev/sync/pull?${q}`, {
      headers: { Origin: ORIGIN, 'X-Account': 'acc-1', Authorization: 'Bearer tok-1' },
    }),
    { ALLOW_ORIGIN: ORIGIN, DB: db },
    { waitUntil: () => {} },
  );
}

async function push(
  db: ReturnType<typeof makeDb>,
  records: unknown[],
  opts: { device?: string; hub?: ReturnType<typeof makeHub> } = {},
) {
  const pending: Promise<unknown>[] = [];
  const res = await worker.default.fetch(
    new Request('https://life-hub-push.workers.dev/sync/push', {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'X-Account': 'acc-1',
        Authorization: 'Bearer tok-1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records, ...(opts.device ? { device: opts.device } : {}) }),
    }),
    { ALLOW_ORIGIN: ORIGIN, DB: db, ...(opts.hub ? { SYNC_HUB: opts.hub } : {}) },
    { waitUntil: (p: Promise<unknown>) => pending.push(p) },
  );
  await Promise.all(pending); // сигнал уходит после ответа — дожидаемся
  return res;
}

describe('/sync/pull: составной курсор', () => {
  it('SQL сравнивает row values (updated_at, id) — иначе записи на границе страницы теряются', async () => {
    const db = makeDb([]);
    await pull(db, '');
    // Форма запроса важна: с эквивалентным OR вместо row values SQLite не
    // делает seek по индексу и сканирует все записи аккаунта на каждый опрос.
    expect(db.pullSql).toHaveLength(1);
    expect(db.pullSql[0]).toContain('(updated_at, id) > (?, ?)');
  });

  it('старый курсор без "|" разбирается как метка с пустым id', async () => {
    const db = makeDb([]);
    await pull(db, '2026-08-16T10:00:00.000Z');
    const [, sinceU, sinceId] = db.pullBinds[0];
    expect(sinceU).toBe('2026-08-16T10:00:00.000Z');
    expect(sinceId).toBe('');
  });

  it('составной курсор "u|id" разбирается на пару', async () => {
    const db = makeDb([]);
    await pull(db, '2026-08-16T10:00:00.000Z|rec-42');
    const [, sinceU, sinceId] = db.pullBinds[0];
    expect(sinceU).toBe('2026-08-16T10:00:00.000Z');
    expect(sinceId).toBe('rec-42');
  });

  it('nextSince — пара последней записи страницы, чтобы одинаковые метки не терялись', async () => {
    const t = '2026-08-16T10:00:00.000Z';
    const db = makeDb([
      { tbl: 'tasks', id: 'a', u: t, d: null, c: 'ct-a' },
      { tbl: 'tasks', id: 'b', u: t, d: null, c: 'ct-b' },
    ]);
    const res = await pull(db, '');
    const data = (await res.json()) as { nextSince: string; records: unknown[] };
    expect(data.records).toHaveLength(2);
    expect(data.nextSince).toBe(`${t}|b`);
  });

  it('пустая страница не сбрасывает курсор', async () => {
    const db = makeDb([]);
    const res = await pull(db, '2026-08-16T10:00:00.000Z|rec-42');
    const data = (await res.json()) as { nextSince: string };
    expect(data.nextSince).toBe('2026-08-16T10:00:00.000Z|rec-42');
  });
});

describe('/sync/pull: страница ограничена объёмом', () => {
  const row = (id: string, size: number): PullRow => ({
    tbl: 'noteFiles',
    id,
    u: '2026-08-22T00:00:00.000Z',
    d: null,
    c: 'x'.repeat(size),
  });

  it('тяжёлые строки режутся по объёму, остаток остаётся на следующую страницу', async () => {
    // Строки бывают очень разные: обычная задача — сотни байт, кусок вложения
    // заметки — больше полумегабайта после шифрования. Пятьсот таких кусков в
    // одном ответе это сотни мегабайт, которые не доедут никогда: обмен падает
    // на каждой попытке, курсор стоит, синхронизация мертва навсегда.
    const db = makeDb([row('a', 1_200_000), row('b', 1_200_000), row('c', 1_200_000), row('d', 1_200_000)]);
    const res = await pull(db, '');
    const body = (await res.json()) as { records: PullRow[]; hasMore: boolean; nextSince: string };

    expect(body.records.length).toBeLessThan(4);
    expect(body.hasMore).toBe(true);
    // Курсор указывает на последнюю отданную запись — остаток приедет следом.
    expect(body.nextSince.endsWith(`|${body.records[body.records.length - 1].id}`)).toBe(true);
  });

  it('одна строка тяжелее потолка всё равно отдаётся — иначе обмен встанет намертво', async () => {
    const db = makeDb([row('big', 5 * 1024 * 1024), row('next', 100)]);
    const res = await pull(db, '');
    const body = (await res.json()) as { records: PullRow[]; hasMore: boolean };
    expect(body.records.map((r) => r.id)).toEqual(['big']);
    expect(body.hasMore).toBe(true);
  });

  it('лёгкие строки отдаются одной страницей, как раньше', async () => {
    const db = makeDb(Array.from({ length: 50 }, (_, i) => row(`t${i}`, 200)));
    const res = await pull(db, '');
    const body = (await res.json()) as { records: PullRow[]; hasMore: boolean };
    expect(body.records).toHaveLength(50);
    expect(body.hasMore).toBe(false);
  });
});

// Курсор по порядку прихода на сервер (migrations/0007).
//
// Дефект: курсор по времени правки ставило устройство-автор по своим часам.
// Запись, пришедшая позже другой, более свежей по метке (телефон создал без
// сети, отправил через час; часы разошлись), для всех, кто ту свежую уже
// получил, становилась невидимой навсегда. Так задачи, заведённые ночью на
// телефоне, не доезжали до мака.
describe('/sync/pull: курсор по seq', () => {
  const row = (id: string, seq: number, dev: string | null = null, size = 4): PullRow & { seq: number; dev: string | null } => ({
    tbl: 'tasks',
    id,
    u: '2026-09-18T01:00:00.000Z',
    d: null,
    c: 'x'.repeat(size),
    seq,
    dev,
  });

  it('выборка идёт по seq одним диапазоном; устройство отсекается уже в ответе', async () => {
    const db = makeDb([]);
    await pullAfter(db, '42', 'dev-mac');
    expect(db.pullSql).toHaveLength(1);
    expect(db.pullSql[0]).toContain('seq > ?');
    expect(db.pullSql[0]).toContain('ORDER BY seq');
    // Фильтра по устройству в SQL нет намеренно: курсор должен двигаться
    // мимо своих записей, иначе устройство, писавшее последним, перечитывало
    // бы свой хвост на каждом опросе.
    expect(db.pullSql[0]).not.toContain('device_id !=');
    expect(db.pullBinds[0][1]).toBe(42);
  });

  it('свои записи не отдаются, но курсор их проходит', async () => {
    const db = makeDb([row('a', 7, 'dev-phone'), row('b', 8, 'dev-mac'), row('c', 9, 'dev-mac')]);
    const res = await pullAfter(db, '5', 'dev-mac');
    const data = (await res.json()) as { nextAfter: number; hasMore: boolean; records: { id: string }[] };
    expect(data.records.map((r) => r.id)).toEqual(['a']);
    expect(data.nextAfter).toBe(9); // а не 7: следующий опрос не перечитает b и c
    expect(data.hasMore).toBe(false);
  });

  it('без device отдаётся всё — старое приложение своих записей не помечало', async () => {
    const db = makeDb([row('a', 1, 'dev-phone'), row('b', 2, null)]);
    const res = await pullAfter(db, '0');
    const data = (await res.json()) as { records: { id: string }[] };
    expect(data.records.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('пустая страница курсор не трогает; страница из одних своих двигает его вперёд', async () => {
    const empty = await pullAfter(makeDb([]), '9');
    expect(((await empty.json()) as { nextAfter: number }).nextAfter).toBe(9);
    const own = await pullAfter(makeDb([row('a', 10, 'me'), row('b', 11, 'me')]), '9', 'me');
    const data = (await own.json()) as { nextAfter: number; records: unknown[] };
    expect(data.records).toHaveLength(0);
    expect(data.nextAfter).toBe(11);
  });

  it('дорезанная по объёму страница ставит курсор на последнюю ОТДАННУЮ запись', async () => {
    const db = makeDb([row('a', 1, 'other', 1_200_000), row('b', 2, 'me'), row('c', 3, 'other', 1_200_000), row('d', 4, 'other', 1_200_000)]);
    const res = await pullAfter(db, '0', 'me');
    const data = (await res.json()) as { nextAfter: number; hasMore: boolean; records: { id: string }[] };
    expect(data.hasMore).toBe(true);
    expect(data.records.map((r) => r.id).length).toBeLessThan(3);
    expect(data.nextAfter).toBe(Number(data.records.length === 2 ? 3 : 1));
  });

  it('страница длиннее лимита: ровно PULL_LIMIT записей, hasMore и курсор на последней отданной', async () => {
    const db = makeDb(Array.from({ length: 501 }, (_, i) => row(`t${i}`, i + 1, 'other')));
    const res = await pullAfter(db, '0', 'me');
    const data = (await res.json()) as { nextAfter: number; hasMore: boolean; records: unknown[] };
    expect(data.records).toHaveLength(500);
    expect(data.hasMore).toBe(true);
    expect(data.nextAfter).toBe(500);
  });

  it('мусор вместо курсора читается как начало, а не роняет запрос', async () => {
    const db = makeDb([]);
    const res = await pullAfter(db, 'abc');
    expect(res.status).toBe(200);
    expect(db.pullBinds[0][1]).toBe(0);
  });

  it('прежний курсор since по-прежнему обслуживается — приложения обновляются не разом', async () => {
    const db = makeDb([]);
    const res = await pull(db, '2026-09-18T01:00:00.000Z|x');
    expect(res.status).toBe(200);
    expect(db.pullSql[0]).toContain('(updated_at, id) > (?, ?)');
  });
});

describe('ленивая миграция колонок seq/device_id', () => {
  it('без колонок воркер добавляет их сам, одной пачкой, и отмечает миграцию применённой', async () => {
    // Воркер деплоится из CI при любом push в main, миграция D1 — ручная;
    // порядок ничем не гарантирован, а без колонки push падал бы всем.
    // Проверка колонок — раз на изолят (память модуля), поэтому воркер здесь
    // поднимается заново: соседние тесты его уже «убедили», что колонки есть.
    vi.resetModules();
    const fresh = await import('./src/index.js');
    const db = makeDb([], { hasColumns: false });
    const res = await fresh.default.fetch(
      new Request('https://life-hub-push.workers.dev/sync/pull?after=0&device=me', {
        headers: { Origin: ORIGIN, 'X-Account': 'acc-1', Authorization: 'Bearer tok-1' },
      }),
      { ALLOW_ORIGIN: ORIGIN, DB: db },
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(200);
    expect(db.ddl.some((d) => d.includes('ADD COLUMN seq'))).toBe(true);
    expect(db.ddl.some((d) => d.includes('ADD COLUMN device_id'))).toBe(true);
    expect(db.ddl.some((d) => d.includes('idx_records_seq'))).toBe(true);
    expect(db.ddl.some((d) => d.includes('SET seq = rowid'))).toBe(true);
    expect(db.ddl.some((d) => d.includes('d1_migrations'))).toBe(true);
  });

  it('колонки есть — DDL не выполняется, а проба идёт один раз на изолят', async () => {
    vi.resetModules();
    const fresh = await import('./src/index.js');
    const db = makeDb([]);
    const call = () =>
      fresh.default.fetch(
        new Request('https://life-hub-push.workers.dev/sync/pull?after=0&device=me', {
          headers: { Origin: ORIGIN, 'X-Account': 'acc-1', Authorization: 'Bearer tok-1' },
        }),
        { ALLOW_ORIGIN: ORIGIN, DB: db },
        { waitUntil: () => {} },
      );
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect(db.ddl).toEqual([]);
    expect(db.probes).toBe(1);
  });

  it('проба упала не из-за колонок — запрос падает, а не залипает «готово» на весь изолят', async () => {
    vi.resetModules();
    const fresh = await import('./src/index.js');
    const db = makeDb([], { hasColumns: false, ddlWorks: false });
    const call = () =>
      fresh.default.fetch(
        new Request('https://life-hub-push.workers.dev/sync/pull?after=0&device=me', {
          headers: { Origin: ORIGIN, 'X-Account': 'acc-1', Authorization: 'Bearer tok-1' },
        }),
        { ALLOW_ORIGIN: ORIGIN, DB: db },
        { waitUntil: () => {} },
      );
    expect((await call()).status).toBe(500);
    const attempts = db.ddl.filter((d) => d.includes('ADD COLUMN seq')).length;
    // Следующий запрос пробует снова — схема не была помечена готовой.
    expect((await call()).status).toBe(500);
    expect(db.ddl.filter((d) => d.includes('ADD COLUMN seq')).length).toBe(attempts + 1);
  });
});

describe('/sync/push: порядок прихода и сигнал остальным', () => {
  const rec = (id: string) => ({
    table: 'tasks',
    id,
    updatedAt: '2026-09-18T01:00:00.000Z',
    deletedAt: null,
    ciphertext: `ct-${id}`,
  });

  it('каждая запись получает следующий seq аккаунта и метку устройства', async () => {
    const db = makeDb([]);
    const res = await push(db, [rec('a'), rec('b')], { device: 'dev-phone' });
    expect(res.status).toBe(200);
    // Первое выражение пачки — починка записей с seq = 0 (вставленных старым
    // кодом в секунды выкатки), потом сами вставки.
    expect(db.pushSql).toHaveLength(3);
    expect(db.pushSql[0]).toMatch(/^UPDATE records/);
    expect(db.pushSql[0]).toContain('seq = 0');
    // Номер считается в самой вставке — и при конфликте обновляется вместе с
    // содержимым, иначе правка существующей записи не попала бы в дельту.
    expect(db.pushSql[1]).toContain('COALESCE(MAX(seq), 0) + 1');
    expect(db.pushSql[1]).toContain('seq = excluded.seq');
    expect(db.pushSql[1]).toContain('device_id = excluded.device_id');
    // Параметры: account, table, id, updatedAt, deletedAt, ciphertext, account (для MAX), device.
    expect(db.pushBinds[1]).toEqual([
      'acc-1', 'tasks', 'a', '2026-09-18T01:00:00.000Z', null, 'ct-a', 'acc-1', 'dev-phone',
    ]);
  });

  it('пачка из одних отвергнутых правок никого не будит', async () => {
    // Устройство переотправляет то, что само же получило: сервер отвергает
    // (там не старее), и будить остальных нечем — иначе каждая правка давала
    // бы второе поколение пустых опросов.
    const db = makeDb([], { changes: 0 });
    const hub = makeHub();
    await push(db, [rec('a')], { device: 'dev-phone', hub });
    expect(hub.calls).toHaveLength(0);
  });

  it('после записи будит SyncHub аккаунта, называя устройство-автора', async () => {
    const db = makeDb([]);
    const hub = makeHub();
    await push(db, [rec('a')], { device: 'dev-phone', hub });
    expect(hub.names).toEqual(['acc-1']);
    expect(hub.calls).toEqual([{ path: '/sync/notify', body: { by: 'dev-phone' } }]);
  });

  it('пустая пачка никого не будит', async () => {
    const db = makeDb([]);
    const hub = makeHub();
    await push(db, [], { device: 'dev-phone', hub });
    expect(hub.calls).toHaveLength(0);
  });

  it('без SyncHub в окружении обмен работает как раньше', async () => {
    const db = makeDb([]);
    const res = await push(db, [rec('a')], { device: 'dev-phone' });
    expect(res.status).toBe(200);
    expect(db.pushBinds).toHaveLength(2);
  });

  it('мусор или отсутствие device пишется как NULL — такие записи отдаются всем', async () => {
    const db = makeDb([]);
    await push(db, [rec('a')], { device: 'dev phone; DROP' });
    expect(db.pushBinds[1][7]).toBeNull();
    const db2 = makeDb([]);
    await push(db2, [rec('a')]);
    expect(db2.pushBinds[1][7]).toBeNull();
  });
});

describe('/sync/ticket и /sync/ws', () => {
  it('тикет выдаётся только с верным токеном и через объект аккаунта', async () => {
    const db = makeDb([]);
    const hub = makeHub();
    const res = await worker.default.fetch(
      new Request('https://life-hub-push.workers.dev/sync/ticket', {
        method: 'POST',
        headers: { Origin: ORIGIN, 'X-Account': 'acc-1', Authorization: 'Bearer tok-1' },
      }),
      { ALLOW_ORIGIN: ORIGIN, DB: db, SYNC_HUB: hub },
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(200);
    expect(hub.names).toEqual(['acc-1']);
    expect(hub.calls[0].path).toBe('/sync/ticket');

    const anon = await worker.default.fetch(
      new Request('https://life-hub-push.workers.dev/sync/ticket', { method: 'POST', headers: { Origin: ORIGIN } }),
      { ALLOW_ORIGIN: ORIGIN, DB: db, SYNC_HUB: hub },
      { waitUntil: () => {} },
    );
    expect(anon.status).toBe(401);
  });

  it('сокет без тикета или с кривым аккаунтом отбивается ещё в воркере', async () => {
    const db = makeDb([]);
    const hub = makeHub();
    const res = await worker.default.fetch(
      new Request('https://life-hub-push.workers.dev/sync/ws?account=acc%20bad', { headers: { Origin: ORIGIN } }),
      { ALLOW_ORIGIN: ORIGIN, DB: db, SYNC_HUB: hub },
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(400);
    expect(hub.calls).toHaveLength(0);
  });
});
