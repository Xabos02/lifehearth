// Регресс-тесты движка синхронизации — каждый ловит конкретный дефект,
// который жил в проде и терял данные:
//
// 1. Курсор push двигался на максимальный updatedAt среди отправленных строк.
//    Правка, сделанная во время скана в уже прочитанную таблицу, получала
//    штамп меньше курсора и не уезжала в облако никогда.
// 2. Между `if (running)` и `running = true` стоял await: два конкурентных
//    вызова runSync проходили проверку и гоняли курсоры наперегонки.
// 3. Одна «ядовитая» запись (битый шифротекст) роняла весь pull: курсор не
//    двигался, синхронизация вставала навсегда.
// 4. У habitLogs уникальный индекс &[habitId+date] при случайных id: отметка
//    привычки с двух устройств давала ConstraintError, запись молча терялась.
// 5. Курсор приёма был меткой времени правки с часов устройства-автора:
//    запись, пришедшая на сервер позже более свежей, для остальных устройств
//    пропадала навсегда. Теперь это порядковый номер прихода (nextAfter).

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { db } = await import('../db/db');
const { generateKey, encryptJSON } = await import('./crypto');
const { getSyncConfig, patchSyncConfig } = await import('./syncState');
const { runSync, batchByBytes } = await import('./sync');
const { liveQuery } = await import('dexie');

const realFetch = globalThis.fetch;

type FetchStub = (url: string, init?: RequestInit) => Promise<Response> | Response;

function jsonRes(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Подменить сеть. Обработчик получает url и init, отвечает за оба эндпоинта. */
function mockFetch(handler: FetchStub) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  ) as typeof fetch;
}

/** Пустой pull + приём push с накоплением отправленных записей. */
function mockQuietNetwork(pushedOut?: { table: string; id: string; updatedAt: string }[]) {
  mockFetch((url, init) => {
    if (url.includes('/sync/pull')) return jsonRes({ records: [], hasMore: false, nextAfter: 0 });
    if (url.includes('/sync/push')) {
      if (pushedOut && init?.body) {
        pushedOut.push(...(JSON.parse(String(init.body)) as { records: typeof pushedOut }).records);
      }
      return jsonRes({ ok: true });
    }
    throw new Error(`неожиданный запрос: ${url}`);
  });
}

async function seedSync(): Promise<CryptoKey> {
  const key = await generateKey();
  await db.sync.put({
    id: 'config',
    accountId: 'acc-1',
    authToken: 'tok-1',
    key,
    enabled: true,
    lastPullAt: '',
    lastPushAt: '',
    lastSyncedAt: '',
  } as never);
  return key;
}

beforeEach(async () => {
  await db.open();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  // Чистим ВСЕ таблицы, а не список поимённо: список молча устаревает, и
  // записи из прошлого теста ломают следующий там, где есть уникальные
  // индексы. Пересоздавать базу всё равно дороже.
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('курсор push', () => {
  it('двигается на cutoff и не перепрыгивает запись, легшую после снятия курсора', async () => {
    await seedSync();
    const past = new Date(Date.now() - 60_000).toISOString();
    // Запись «из будущего» моделирует правку, сделанную ПОСЛЕ снятия cutoff,
    // но ДО конца цикла — раньше она задирала курсор и терялась навсегда.
    // Запас 150 мс: между этой строкой и снятием cutoff в runSync — только
    // два put и мок сети, на порядок быстрее даже под нагрузкой CI.
    const future = new Date(Date.now() + 150).toISOString();
    await db.tasks.put({ id: 't-past', title: 'a', updatedAt: past, deletedAt: null } as never);
    await db.tasks.put({ id: 't-future', title: 'b', updatedAt: future, deletedAt: null } as never);

    const sent: { table: string; id: string; updatedAt: string }[] = [];
    mockQuietNetwork(sent);

    const r1 = await runSync();
    // Уехала только запись из окна; будущая — нет.
    expect(r1?.pushed).toBe(1);
    expect(sent.map((s) => s.id)).toEqual(['t-past']);
    // Курсор — cutoff цикла, он ОБЯЗАН быть меньше updatedAt будущей записи.
    // Старый код ставил сюда max(updatedAt)=future и запись выпадала навсегда.
    const c1 = await getSyncConfig();
    expect(c1 && c1.lastPushAt < future).toBe(true);

    // Время записи наступило — следующий цикл её доставляет.
    await new Promise((res) => setTimeout(res, 200));
    const r2 = await runSync();
    expect(r2?.pushed).toBe(1);
    expect(sent.map((s) => s.id)).toEqual(['t-past', 't-future']);
  });
});

describe('критическая секция runSync', () => {
  it('конкурентный вызов не запускает второй цикл параллельно — он идёт следом', async () => {
    await seedSync();
    let pullCalls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    mockFetch(async (url) => {
      if (url.includes('/sync/pull')) {
        pullCalls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((res) => setTimeout(res, 20)); // держим цикл занятым
        inFlight--;
        return jsonRes({ records: [], hasMore: false, nextAfter: 0 });
      }
      return jsonRes({ ok: true });
    });

    const [a, b] = await Promise.all([runSync(), runSync()]);
    // Второй вызов вышел по флагу — гонки курсоров нет. Но просьба не
    // пропала: первый цикл, закончив, прогнал ещё один круг. Раньше такой
    // вызов терялся, и правка, сделанная во время обмена (или чужая, о
    // которой сообщил сокет), ждала следующего повода — до минуты.
    expect(maxInFlight).toBe(1);
    expect(pullCalls).toBe(2);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('вызов после конца цикла новых кругов не плодит', async () => {
    await seedSync();
    let pullCalls = 0;
    mockFetch(async (url) => {
      if (url.includes('/sync/pull')) {
        pullCalls++;
        return jsonRes({ records: [], hasMore: false, nextAfter: 0 });
      }
      return jsonRes({ ok: true });
    });
    await runSync();
    expect(pullCalls).toBe(1);
  });
});

describe('ядовитая запись в pull', () => {
  it('пропускается со счётчиком, не роняя цикл и не блокируя курсор', async () => {
    const key = await seedSync();
    const t = new Date().toISOString();
    const good = await encryptJSON(key, { id: 'n-ok', title: 'жив', updatedAt: t, deletedAt: null });
    mockFetch((url) => {
      if (url.includes('/sync/pull'))
        return jsonRes({
          records: [
            // Кириллица не пройдёт atob → InvalidCharacterError, запись «ядовитая».
            { table: 'notes', id: 'n-bad', updatedAt: t, deletedAt: null, ciphertext: 'мусор' },
            { table: 'notes', id: 'n-ok', updatedAt: t, deletedAt: null, ciphertext: good },
          ],
          hasMore: false,
          nextAfter: 7,
        });
      return jsonRes({ ok: true });
    });

    const r = await runSync();
    // Битая пропущена и посчитана, валидная применена, курсор уехал вперёд.
    expect(r?.skipped).toBe(1);
    expect(r?.pulled).toBe(1);
    expect(await db.notes.get('n-ok')).toBeTruthy();
    const c = await getSyncConfig();
    expect(c?.lastPullSeq).toBe(7);
  });
});

describe('конфликт habitLogs по [habitId+date]', () => {
  it('входящая свежее — локальный дубль снимается, входящая записывается', async () => {
    const key = await seedSync();
    const older = '2026-08-16T10:00:00.000Z';
    const newer = '2026-08-16T11:00:00.000Z';
    await db.habitLogs.put({ id: 'local', habitId: 'h1', date: '2026-08-16', updatedAt: older, deletedAt: null } as never);
    const ct = await encryptJSON(key, { id: 'remote', habitId: 'h1', date: '2026-08-16', updatedAt: newer, deletedAt: null });
    mockFetch((url) => {
      if (url.includes('/sync/pull'))
        return jsonRes({
          records: [{ table: 'habitLogs', id: 'remote', updatedAt: newer, deletedAt: null, ciphertext: ct }],
          hasMore: false,
          nextAfter: 3,
        });
      return jsonRes({ ok: true });
    });

    const r = await runSync();
    // Без разрешения конфликта put падал ConstraintError и запись терялась.
    expect(r?.pulled).toBe(1);
    expect(await db.habitLogs.get('remote')).toBeTruthy();
    expect(await db.habitLogs.get('local')).toBeUndefined();
  });

  it('локальная свежее — входящая игнорируется', async () => {
    const key = await seedSync();
    const older = '2026-08-16T10:00:00.000Z';
    const newer = '2026-08-16T11:00:00.000Z';
    await db.habitLogs.put({ id: 'local', habitId: 'h1', date: '2026-08-16', updatedAt: newer, deletedAt: null } as never);
    const ct = await encryptJSON(key, { id: 'remote', habitId: 'h1', date: '2026-08-16', updatedAt: older, deletedAt: null });
    mockFetch((url) => {
      if (url.includes('/sync/pull'))
        return jsonRes({
          records: [{ table: 'habitLogs', id: 'remote', updatedAt: older, deletedAt: null, ciphertext: ct }],
          hasMore: false,
          nextAfter: 3,
        });
      return jsonRes({ ok: true });
    });

    await runSync();
    expect(await db.habitLogs.get('local')).toBeTruthy();
    expect(await db.habitLogs.get('remote')).toBeUndefined();
  });
});

describe('конфликт energyLogs по date', () => {
  // У energyLogs уникальный индекс &date (db.ts, версия 16) — «одна отметка в
  // день». Та же ловушка, что у привычек, но разрешения конфликта для неё не
  // было: put падал с ConstraintError, а ConstraintError не считается
  // «ядовитой записью», значит pullPage бросал ошибку дальше и курсор
  // курсор не двигался. Синхронизация вставала НАВСЕГДА и молча — вместе
  // с задачами, заметками, целями и финансами.
  it('входящая свежее — локальный дубль снимается, синк не встаёт', async () => {
    const key = await seedSync();
    const older = '2026-08-16T10:00:00.000Z';
    const newer = '2026-08-16T11:00:00.000Z';
    await db.energyLogs.put({ id: 'local', date: '2026-08-16', level: 2, updatedAt: older, deletedAt: null } as never);
    const ct = await encryptJSON(key, { id: 'remote', date: '2026-08-16', level: 5, updatedAt: newer, deletedAt: null });
    mockFetch((url) => {
      if (url.includes('/sync/pull'))
        return jsonRes({
          records: [{ table: 'energyLogs', id: 'remote', updatedAt: newer, deletedAt: null, ciphertext: ct }],
          hasMore: false,
          nextAfter: 3,
        });
      return jsonRes({ ok: true });
    });

    const r = await runSync();
    expect(r?.pulled).toBe(1);
    expect(await db.energyLogs.get('remote')).toBeTruthy();
    expect(await db.energyLogs.get('local')).toBeUndefined();
    // И главное: курсор уехал вперёд, то есть следующий цикл пойдёт дальше.
    const c = await getSyncConfig();
    expect(c?.lastPullSeq).toBe(3);
  });

  it('локальная свежее — входящая игнорируется', async () => {
    const key = await seedSync();
    const older = '2026-08-16T10:00:00.000Z';
    const newer = '2026-08-16T11:00:00.000Z';
    await db.energyLogs.put({ id: 'local', date: '2026-08-16', level: 4, updatedAt: newer, deletedAt: null } as never);
    const ct = await encryptJSON(key, { id: 'remote', date: '2026-08-16', level: 1, updatedAt: older, deletedAt: null });
    mockFetch((url) => {
      if (url.includes('/sync/pull'))
        return jsonRes({
          records: [{ table: 'energyLogs', id: 'remote', updatedAt: older, deletedAt: null, ciphertext: ct }],
          hasMore: false,
          nextAfter: 3,
        });
      return jsonRes({ ok: true });
    });

    await runSync();
    expect(await db.energyLogs.get('local')).toBeTruthy();
    expect(await db.energyLogs.get('remote')).toBeUndefined();
  });

  it('мягко удалённая отметка держит дату — входящая всё равно применяется', async () => {
    // Снять отметку через приложение = мягкое удаление: строка остаётся и
    // продолжает занимать date. Без разрешения конфликта человек не мог бы
    // починить синк даже вручную.
    const key = await seedSync();
    const older = '2026-08-16T10:00:00.000Z';
    const newer = '2026-08-16T11:00:00.000Z';
    await db.energyLogs.put({
      id: 'local', date: '2026-08-16', level: 2, updatedAt: older, deletedAt: older,
    } as never);
    const ct = await encryptJSON(key, { id: 'remote', date: '2026-08-16', level: 5, updatedAt: newer, deletedAt: null });
    mockFetch((url) => {
      if (url.includes('/sync/pull'))
        return jsonRes({
          records: [{ table: 'energyLogs', id: 'remote', updatedAt: newer, deletedAt: null, ciphertext: ct }],
          hasMore: false,
          nextAfter: 3,
        });
      return jsonRes({ ok: true });
    });

    const r = await runSync();
    expect(r?.pulled).toBe(1);
    expect(await db.energyLogs.get('remote')).toBeTruthy();
  });
});

describe('отправка изменений не читает таблицы целиком', () => {
  it('берёт окно по индексу updatedAt, а не всю базу', async () => {
    // Раньше push читал КАЖДУЮ из двадцати синхронизируемых таблиц целиком и
    // отбирал свежие строки уже в памяти. Среди них noteFiles — куски
    // вложений по 400 КиБ — и tasks с фотографиями прямо в строке. И всё это
    // через полторы секунды после каждой правки: пока пишешь заметку, на
    // каждую паузу в наборе поднималась вся база.
    //
    // Отличить одно от другого можно точно: полное чтение идёт через
    // store.getAll, выборка по индексу — через index.getAll.
    await seedSync();
    const old = '2020-01-01T00:00:00.000Z';
    // Полсотни старых записей, которые отправлять не нужно.
    await db.notes.bulkPut(
      Array.from({ length: 50 }, (_, i) => ({
        id: `n${i}`,
        title: `Заметка ${i}`,
        content: 'x'.repeat(5000),
        createdAt: old,
        updatedAt: old,
        deletedAt: null,
      })) as never[],
    );
    await patchSyncConfig({ lastPushAt: '2026-01-01T00:00:00.000Z' });
    // И одна свежая — только она и должна уехать.
    const fresh = new Date().toISOString();
    await db.notes.put({
      id: 'fresh', title: 'Свежая', content: 'привет',
      createdAt: fresh, updatedAt: fresh, deletedAt: null,
    } as never);

    // Считаем ИМЕНА таблиц, прочитанных целиком: пара служебных (например,
    // список семейных подключений — единицы строк) читается полностью и
    // законно, а вот синхронизируемых среди них быть не должно.
    const scanned: string[] = [];
    let indexReads = 0;
    const orig = {
      store: IDBObjectStore.prototype.getAll,
      index: IDBIndex.prototype.getAll,
    };
    IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args: unknown[]) {
      scanned.push(this.name);
      return (orig.store as (...a: unknown[]) => IDBRequest).apply(this, args);
    } as typeof orig.store;
    IDBIndex.prototype.getAll = function (this: IDBIndex, ...args: unknown[]) {
      indexReads += 1;
      return (orig.index as (...a: unknown[]) => IDBRequest).apply(this, args);
    } as typeof orig.index;

    const pushed: { table: string; id: string; updatedAt: string }[] = [];
    mockQuietNetwork(pushed);

    try {
      await runSync();
    } finally {
      IDBObjectStore.prototype.getAll = orig.store;
      IDBIndex.prototype.getAll = orig.index;
    }

    // Уехала ровно свежая запись.
    expect(pushed.map((r) => r.id)).toEqual(['fresh']);
    // Ни одна таблица с пользовательскими данными не прочитана целиком.
    expect(scanned.filter((name) => name === 'notes' || name === 'tasks' || name === 'noteFiles')).toEqual([]);
    expect(indexReads).toBeGreaterThan(0);
  });
});

describe('семейные подключения уезжают на другие устройства', () => {
  it('свежая группа попадает в отправку, старая — нет', async () => {
    // Группы читаются иначе, чем остальные таблицы (индекса по updatedAt у них
    // нет, да и групп единицы), поэтому отбор окна для них написан отдельно —
    // и однажды уже отвалился при правке соседнего кода: осталась ссылка на
    // удалённую функцию, то есть отправка падала бы целиком.
    await seedSync();
    await patchSyncConfig({ lastPushAt: '2026-01-01T00:00:00.000Z' });
    const key = await generateKey();
    const base = {
      familyToken: 'tok', familyKey: key, familyName: 'Наши', selfMemberId: 'me',
      lastSeq: 0, lastReadSeq: 0, enabled: true, joinedAt: '2026-01-01T00:00:00.000Z',
      keyEpoch: 0, keyRing: { '0': key }, deletedAt: null,
    };
    await db.family.bulkPut([
      { ...base, id: 'old', familyId: 'old', updatedAt: '2025-06-01T00:00:00.000Z' },
      { ...base, id: 'new', familyId: 'new', updatedAt: new Date().toISOString() },
    ] as never[]);

    const sent: { table: string; id: string; updatedAt: string }[] = [];
    mockQuietNetwork(sent);
    await runSync();

    const shares = sent.filter((r) => r.table === 'familyShare');
    expect(shares.map((r) => r.id)).toEqual(['new']);
  });
});

describe('пачки отправки ограничены объёмом, а не только числом записей', () => {
  it('тяжёлые записи едут порознь — иначе тело запроса вырастает до сотен мегабайт', () => {
    // Строки бывают очень разные: обычная задача — сотни байт, кусок вложения
    // заметки — больше полумегабайта после шифрования. Двести таких кусков в
    // одном теле запроса не уйдут никогда: обмен падает на каждой попытке,
    // курсор стоит, синхронизация мертва навсегда.
    const heavy = (id: string) => ({
      table: 'noteFiles',
      id,
      updatedAt: '2026-08-22T00:00:00.000Z',
      deletedAt: null,
      ciphertext: 'x'.repeat(1_200_000),
    });
    const batches = batchByBytes([heavy('a'), heavy('b'), heavy('c'), heavy('d')]);

    // По три штуки в пачку не влезает — потолок три мегабайта.
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      const size = b.reduce((n, r) => n + r.ciphertext.length, 0);
      // Пачка либо в пределах потолка, либо состоит из одной записи.
      expect(size <= 3 * 1024 * 1024 || b.length === 1).toBe(true);
    }
    // Ничего не потеряли и порядок сохранён.
    expect(batches.flat().map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('запись тяжелее потолка едет одна, а не блокирует обмен', () => {
    const giant = {
      table: 'noteFiles', id: 'big', updatedAt: '2026-08-22T00:00:00.000Z',
      deletedAt: null, ciphertext: 'x'.repeat(5 * 1024 * 1024),
    };
    const small = {
      table: 'tasks', id: 't1', updatedAt: '2026-08-22T00:00:01.000Z',
      deletedAt: null, ciphertext: 'привет',
    };
    const batches = batchByBytes([giant, small]);
    expect(batches[0].map((r) => r.id)).toEqual(['big']);
    expect(batches[1].map((r) => r.id)).toEqual(['t1']);
  });

  it('лёгкие записи собираются в пачку, а не по одной', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      table: 'tasks', id: `t${i}`, updatedAt: '2026-08-22T00:00:00.000Z',
      deletedAt: null, ciphertext: 'короткая строка',
    }));
    expect(batchByBytes(rows)).toHaveLength(1);
  });
});

describe('запись, которую сервер не примет, не вешает обмен навсегда', () => {
  it('слишком большая запись пропускается, остальное уезжает, курсор двигается', async () => {
    // У задачи фотографии лежат прямо в строке. Десяток снимков — и шифротекст
    // одной записи перерастает то, что колонка на сервере способна принять
    // (D1: значение колонки ≤ 2 МБ). Сервер отказывает на всей пачке, клиент
    // роняет цикл, курсор не двигается — и на следующем круге всё повторяется.
    // Синхронизация встаёт НАСОВСЕМ: перестают ездить и заметки, и цели, и
    // финансы, причём молча.
    await seedSync();
    const t = new Date().toISOString();
    // Задача с «фотографиями»: одна строка заведомо больше лимита.
    await db.tasks.put({
      id: 'heavy', title: 'Товар для РТЭ', photos: ['x'.repeat(2_500_000)],
      createdAt: t, updatedAt: t, deletedAt: null,
    } as never);
    await db.tasks.put({
      id: 'light', title: 'Обычная задача',
      createdAt: t, updatedAt: t, deletedAt: null,
    } as never);

    const sent: { table: string; id: string; updatedAt: string }[] = [];
    mockQuietNetwork(sent);

    const r = await runSync();

    // Лёгкая задача уехала.
    expect(sent.map((x) => x.id)).toContain('light');
    // Неподъёмная — нет, и это не помешало циклу дойти до конца.
    expect(sent.map((x) => x.id)).not.toContain('heavy');
    expect(r).toBeTruthy();
    // Курсор двинулся — следующий цикл пойдёт дальше, а не упрётся в ту же запись.
    const c = await getSyncConfig();
    expect(c?.lastPushAt).not.toBe('');
  });

  it('о непосланных записях сказано, а не проглочено', async () => {
    await seedSync();
    const t = new Date().toISOString();
    await db.tasks.put({
      id: 'heavy', title: 'Товар', photos: ['x'.repeat(2_500_000)],
      createdAt: t, updatedAt: t, deletedAt: null,
    } as never);
    mockQuietNetwork();

    const r = await runSync();
    expect(r?.oversized).toBe(1);
  });
});

describe('перечитывание истории не теряет прогресс при обрыве', () => {
  it('курсор двигается после каждой страницы, а не только в конце', async () => {
    // Полное перечитывание случается после каждого релиза, добавившего таблицу
    // в обмен. Оно идёт страницами, и если курсор сохранять только в самом
    // конце, обрыв посередине (закрыли вкладку, пропала сеть) стирает весь
    // прогресс. На большой истории с вложениями телефон может не досидеть до
    // конца никогда и качать одно и то же.
    const key = await seedSync();
    const t1 = '2026-08-22T00:00:01.000Z';
    const ct = await encryptJSON(key, { id: 'n1', title: 'Заметка', content: '', updatedAt: t1, deletedAt: null });

    let pulls = 0;
    mockFetch((url) => {
      if (url.includes('/sync/pull')) {
        pulls++;
        if (pulls === 1) {
          return jsonRes({
            records: [{ table: 'notes', id: 'n1', updatedAt: t1, deletedAt: null, ciphertext: ct }],
            hasMore: true,
            nextAfter: 1,
          });
        }
        // Вторая страница не доехала — обрыв связи.
        return new Response('', { status: 500 });
      }
      return jsonRes({ ok: true });
    });

    await expect(runSync()).rejects.toThrow();

    // Первая страница применена и ЗАСЧИТАНА: следующий заход продолжит с неё,
    // а не начнёт всё сначала.
    expect(await db.notes.get('n1')).toBeTruthy();
    const c = await getSyncConfig();
    expect(c?.lastPullSeq).toBe(1);
  });
});

describe('страница входящих применяется одной пачкой', () => {
  it('подписки экранов просыпаются раз на страницу, а не на каждую запись', async () => {
    // После релиза, добавившего таблицу в обмен, приложение перечитывает всю
    // историю. Пятьсот записей, применённых по одной, — это пятьсот пробуждений
    // подписок и столько же перерисовок подряд: на телефоне выглядит как
    // зависший экран.
    const key = await seedSync();
    const t = '2026-08-22T09:00:00.000Z';
    const records = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => ({
        table: 'tasks',
        id: `t${i}`,
        updatedAt: `2026-08-22T09:00:${String(i).padStart(2, '0')}.000Z`,
        deletedAt: null,
        ciphertext: await encryptJSON(key, {
          id: `t${i}`, title: `Задача ${i}`,
          createdAt: t, updatedAt: `2026-08-22T09:00:${String(i).padStart(2, '0')}.000Z`, deletedAt: null,
        }),
      })),
    );

    // Считаем пробуждения живой подписки — ровно то, от чего перерисовываются
    // экраны.
    let wakes = 0;
    const sub = liveQuery(() => db.tasks.count()).subscribe(() => {
      wakes++;
    });
    await new Promise((r) => setTimeout(r, 50)); // первое срабатывание — начальное

    mockFetch((url) => {
      if (url.includes('/sync/pull'))
        return jsonRes({ records, hasMore: false, nextAfter: 12 });
      return jsonRes({ ok: true });
    });

    const r = await runSync();
    await new Promise((r) => setTimeout(r, 100));
    sub.unsubscribe();

    // Все двенадцать записей применены.
    expect(r?.pulled).toBe(12);
    expect(await db.tasks.count()).toBe(12);
    // Пробуждений заметно меньше, чем записей: страница применена пачкой.
    // По одной было бы не меньше двенадцати.
    expect(wakes).toBeLessThan(6);
  });

  it('битая запись пропускается, остальные с той же страницы применяются', async () => {
    const key = await seedSync();
    const t = '2026-08-22T09:00:00.000Z';
    const good = await encryptJSON(key, { id: 'ok', title: 'Целая', createdAt: t, updatedAt: t, deletedAt: null });
    mockFetch((url) => {
      if (url.includes('/sync/pull'))
        return jsonRes({
          records: [
            { table: 'tasks', id: 'bad', updatedAt: t, deletedAt: null, ciphertext: 'мусор' },
            { table: 'tasks', id: 'ok', updatedAt: t, deletedAt: null, ciphertext: good },
          ],
          hasMore: false,
          nextAfter: 2,
        });
      return jsonRes({ ok: true });
    });

    const r = await runSync();
    expect(r?.skipped).toBe(1);
    expect(await db.tasks.get('ok')).toBeTruthy();
    expect(await db.tasks.get('bad')).toBeUndefined();
  });
});

describe('курсор приёма — порядок прихода на сервер', () => {
  it('спрашивает сервер по after, двигает lastPullSeq и представляется устройством', async () => {
    const key = await seedSync();
    // knownTables ставит первый же круг — иначе защита от новых таблиц
    // честно перечитает всё с нуля, и after=40 не дойдёт до сервера.
    mockQuietNetwork();
    await runSync();
    await patchSyncConfig({ lastPullSeq: 40 });
    const ct = await encryptJSON(key, {
      id: 'late',
      title: 'Ночная задача',
      updatedAt: '2026-09-18T01:00:00.000Z',
      deletedAt: null,
    });
    const urls: string[] = [];
    mockFetch((url) => {
      if (url.includes('/sync/pull')) {
        urls.push(url);
        // Метка записи СТАРЕЕ всего, что устройство уже видело, — но пришла
        // она позже (seq 41 > 40), и по seq её видно. По времени — не было бы.
        return jsonRes({
          records: [{ table: 'tasks', id: 'late', updatedAt: '2026-09-18T01:00:00.000Z', deletedAt: null, ciphertext: ct }],
          hasMore: false,
          nextAfter: 41,
        });
      }
      return jsonRes({ ok: true });
    });

    const r = await runSync();
    expect(r?.pulled).toBe(1);
    expect(urls[0]).toContain('/sync/pull?after=40');
    expect(await db.tasks.get('late')).toBeTruthy();
    const c = await getSyncConfig();
    expect(c?.lastPullSeq).toBe(41);
    // Имя устройства выдано при первом обмене и едет в строке запроса (не
    // заголовком: новый заголовок — новый preflight, и приложение, обновившееся
    // раньше сервера, ломалось бы целиком) — сервер по нему не отдаёт
    // устройству его же записи.
    expect(c?.deviceId).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(urls[0]).toContain(`&device=${c?.deviceId}`);
  });

  it('конфиг без lastPullSeq (старое приложение) читает с нуля — один раз', async () => {
    await seedSync();
    // knownTables должен быть на месте, иначе сработает другая защита (новые
    // таблицы → перечитать всё) и до фолбэка `?? 0` дело не дойдёт вовсе.
    mockQuietNetwork();
    await runSync();
    const c = await getSyncConfig();
    await db.sync.put({ ...c, lastPullSeq: undefined } as never);
    const urls: string[] = [];
    mockFetch((url) => {
      if (url.includes('/sync/pull')) {
        urls.push(url);
        return jsonRes({ records: [], hasMore: false, nextAfter: 40 });
      }
      return jsonRes({ ok: true });
    });
    await runSync();
    expect(urls[0]).toContain('after=0');
    expect((await getSyncConfig())?.lastPullSeq).toBe(40);
  });

  it('сервер без nextAfter (ещё не обновился) курсор по seq не ломает, а по времени двигает', async () => {
    // Старый сервер читает только since: без него он отдавал бы всю историю
    // на каждом опросе, пока не выкатится. Поэтому прежний курсор едет рядом
    // с новым и двигается по старому ответу.
    await seedSync();
    mockQuietNetwork();
    await runSync(); // knownTables
    await patchSyncConfig({ lastPullSeq: 5, lastPullAt: '2026-09-18T01:00:00.000Z|a' });
    const urls: string[] = [];
    let pulls = 0;
    mockFetch((url) => {
      if (url.includes('/sync/pull')) {
        urls.push(url);
        pulls++;
        return jsonRes({ records: [], hasMore: pulls === 1, nextSince: pulls === 1 ? 'x|y' : 'x|z' });
      }
      return jsonRes({ ok: true });
    });
    await runSync();
    const c = await getSyncConfig();
    expect(c?.lastPullSeq).toBe(5);
    expect(c?.lastPullAt).toBe('x|z');
    expect(urls[0]).toContain('since=2026-09-18T01%3A00%3A00.000Z%7Ca');
    expect(urls[1]).toContain('since=x%7Cy'); // вторая страница — с курсора первой
  });
});

describe('отправка перед уходом в фон', () => {
  it('flushSyncNow отправляет накопленное сразу, не дожидаясь паузы', async () => {
    const { scheduleSyncSoon, flushSyncNow } = await import('./sync');
    await seedSync();
    const past = new Date(Date.now() - 1000).toISOString();
    await db.tasks.put({ id: 't-bg', title: 'перед блокировкой', updatedAt: past, deletedAt: null } as never);
    const sent: { table: string; id: string; updatedAt: string }[] = [];
    const order: string[] = [];
    let keepalive: boolean | undefined;
    mockFetch((url, init) => {
      if (url.includes('/sync/pull')) {
        order.push('pull');
        return jsonRes({ records: [], hasMore: false, nextAfter: 0 });
      }
      if (url.includes('/sync/push')) {
        order.push('push');
        keepalive = init?.keepalive;
        sent.push(...(JSON.parse(String(init?.body)) as { records: typeof sent }).records);
        return jsonRes({ ok: true });
      }
      throw new Error(`неожиданный запрос: ${url}`);
    });
    scheduleSyncSoon();
    flushSyncNow();
    // Дождаться ВСЕГО круга (отправка, потом приём): он стартовал из
    // flushSyncNow без ожидания, и оборванный на середине круг ушёл бы в
    // следующие тесты с настоящей сетью.
    for (let i = 0; i < 100 && order.length < 2; i++) await new Promise((res) => setTimeout(res, 10));
    expect(sent.map((s) => s.id)).toEqual(['t-bg']);
    // Маленькая пачка едет с keepalive — доедет и из свёрнутого приложения.
    expect(keepalive).toBe(true);
    // И отправка идёт ПЕРВОЙ: приём перед ней iPhone мог бы уже не дождаться.
    expect(order).toEqual(['push', 'pull']);
  });

  it('без накопленного flushSyncNow ничего не запускает', async () => {
    const { flushSyncNow } = await import('./sync');
    await seedSync();
    let calls = 0;
    mockFetch(() => {
      calls++;
      return jsonRes({ records: [], hasMore: false, nextAfter: 0 });
    });
    flushSyncNow();
    await new Promise((res) => setTimeout(res, 30));
    expect(calls).toBe(0);
  });
});

describe('просьба о повторном круге не теряется', () => {
  it('вызов в хвосте цикла (после кругов, до конца) даёт новый цикл', async () => {
    await seedSync();
    let pullCalls = 0;
    let kicked = false;
    mockFetch((url) => {
      if (url.includes('/sync/pull')) pullCalls++;
      return jsonRes({ records: [], hasMore: false, nextAfter: 0, ok: true });
    });
    // Хвост цикла — запись lastSyncedAt. Ловим её и просим ещё круг ровно там:
    // раньше finally стирал флаг, и сигнал сокета откатывался к минутному опросу.
    const realPut = db.sync.put.bind(db.sync);
    vi.spyOn(db.sync, 'put').mockImplementation(((obj: { lastSyncedAt?: string }, key?: string) => {
      if (!kicked && obj.lastSyncedAt && obj.lastSyncedAt !== '') {
        kicked = true;
        void runSync();
      }
      return realPut(obj as never, key as never);
    }) as never);
    await runSync();
    for (let i = 0; i < 50 && pullCalls < 2; i++) await new Promise((res) => setTimeout(res, 10));
    expect(kicked).toBe(true);
    expect(pullCalls).toBe(2);
  });
});

describe('эхо: принятое с сервера не уезжает обратно', () => {
  it('запись, применённая по pull, в следующую отправку не попадает; правленная — попадает', async () => {
    const key = await seedSync();
    mockQuietNetwork();
    await runSync(); // knownTables и курсоры на месте
    // Чужая правка СВЕЖЕЕ нашего прошлого круга — обычное дело: именно так
    // её метка и попадает в наше окно отправки.
    await new Promise((res) => setTimeout(res, 5));
    const t = new Date().toISOString();
    const ct = await encryptJSON(key, { id: 'echo', title: 'чужая', updatedAt: t, deletedAt: null });
    const sent: { id: string }[] = [];
    let served = false;
    mockFetch((url, init) => {
      if (url.includes('/sync/pull')) {
        if (served) return jsonRes({ records: [], hasMore: false, nextAfter: 5 });
        served = true;
        return jsonRes({
          records: [{ table: 'tasks', id: 'echo', updatedAt: t, deletedAt: null, ciphertext: ct }],
          hasMore: false,
          nextAfter: 5,
        });
      }
      sent.push(...(JSON.parse(String(init?.body)) as { records: { id: string }[] }).records);
      return jsonRes({ ok: true });
    });
    await runSync();
    expect(await db.tasks.get('echo')).toBeTruthy();
    // Метка чужой правки попадает в окно отправки — но это та же строка, что
    // пришла: уезжать обратно (с фотографиями по сотням килобайт) ей незачем.
    expect(sent.map((r) => r.id)).not.toContain('echo');
    // А правленная здесь получает новую метку и едет как положено. Правим
    // напрямую в базе, а не через repo: тот заводит таймер отложенной
    // отправки, который пережил бы тест и выстрелил бы в соседнем.
    await db.tasks.update('echo', { title: 'моя', updatedAt: new Date().toISOString() });
    await runSync();
    expect(sent.map((r) => r.id)).toContain('echo');
  });
});

describe('имя устройства', () => {
  it('два одновременных запроса имени дают одно имя — то, что сохранено', async () => {
    // Первый обмен после обновления зовёт выдачу сразу из двух мест: круг
    // обмена и живое соединение. Без общей выдачи у устройства было бы два
    // имени, и сервер отдавал бы ему его же записи.
    const { ensureDeviceId } = await import('./sync');
    await seedSync();
    const c = (await getSyncConfig())!;
    const [a, b] = await Promise.all([ensureDeviceId(c), ensureDeviceId(c)]);
    expect(a.deviceId).toBeTruthy();
    expect(a.deviceId).toBe(b.deviceId);
    expect((await getSyncConfig())?.deviceId).toBe(a.deviceId);
  });
});

describe('полное перечитывание', () => {
  it('сбрасывает курсоры и меняет имя устройства — сервер отдаст прежние свои записи как чужие', async () => {
    const { requestFullResync } = await import('./sync');
    await seedSync();
    mockQuietNetwork();
    await runSync();
    const before = await getSyncConfig();
    await patchSyncConfig({ lastPullSeq: 77 });
    await requestFullResync();
    const after = await getSyncConfig();
    expect(after?.lastPullSeq).toBe(0);
    expect(after?.lastPushAt).toBe('');
    expect(after?.deviceId).toBeTruthy();
    expect(after?.deviceId).not.toBe(before?.deviceId);
  });

  it('просьба во время идущего круга не перезаписывается его курсорами', async () => {
    const { requestFullResync } = await import('./sync');
    await seedSync();
    mockQuietNetwork();
    await runSync();
    const urls: string[] = [];
    let resolvePull: (() => void) | null = null;
    let pulls = 0;
    mockFetch(async (url) => {
      if (url.includes('/sync/pull')) {
        urls.push(url);
        pulls++;
        if (pulls === 1) await new Promise<void>((r) => (resolvePull = r)); // первый круг завис на приёме
        return jsonRes({ records: [], hasMore: false, nextAfter: 33 });
      }
      return jsonRes({ ok: true });
    });
    const first = runSync();
    for (let i = 0; i < 50 && !resolvePull; i++) await new Promise((res) => setTimeout(res, 5));
    await requestFullResync(); // пока круг идёт
    resolvePull!();
    await first;
    // Круг дописал бы lastPullSeq=33 поверх сброса — но сброс повторился в
    // его следующем круге, и тот пошёл с нуля.
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls[urls.length - 1]).toContain('after=0');
  });
});

describe('напоминание задачи, пришедшей с другого устройства', () => {
  it('задачу выполнили на устройстве без уведомлений — этот телефон снимает её напоминание', async () => {
    // Мак без пушей закрыл задачу; напоминание стоит на подписке этого
    // телефона — раньше оно приходило о сделанном деле.
    const store = new Map([['life-hub-push-sub', JSON.stringify({ endpoint: 'https://push.example/1' })]]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: () => {}, removeItem: () => {} });
    const key = await seedSync();
    const older = '2026-09-25T10:00:00.000Z';
    const newer = '2026-09-25T11:00:00.000Z';
    const task = { id: 't1', title: 'Позвонить в банк', dueDate: '2099-01-01', dueTime: '14:30', remindBefore: 15, deletedAt: null };
    await db.tasks.put({ ...task, completedAt: null, updatedAt: older } as never);
    const ct = await encryptJSON(key, { ...task, completedAt: newer, updatedAt: newer });
    const cancels: string[] = [];
    mockFetch((url, init) => {
      if (url.includes('/sync/pull'))
        return jsonRes({ records: [{ table: 'tasks', id: 't1', updatedAt: newer, deletedAt: null, ciphertext: ct }], hasMore: false, nextAfter: 3 });
      if (url.includes('/cancel')) cancels.push(String(init?.body));
      return jsonRes({ ok: true });
    });
    try {
      await runSync();
      await vi.waitFor(() => expect(cancels).toEqual([JSON.stringify({ taskId: 't1' })]));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
