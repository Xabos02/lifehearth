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
 *  выборка pull отдаёт заготовленные строки и записывает связанные параметры. */
function makeDb(rows: PullRow[]) {
  const pullBinds: unknown[][] = [];
  const pullSql: string[] = [];
  return {
    pullBinds,
    pullSql,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              return null; // accounts: не найден → TOFU-регистрация
            },
            async run() {
              return {}; // INSERT INTO accounts
            },
            async all() {
              if (!sql.includes('FROM records')) throw new Error(`неожиданный all(): ${sql}`);
              pullSql.push(sql);
              pullBinds.push(args);
              return { results: rows };
            },
          };
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
