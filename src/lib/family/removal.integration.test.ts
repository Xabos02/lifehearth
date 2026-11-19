// Сквозная проверка исключения участника: настоящий клиент против настоящего
// сервера.
//
// Отдельные части уже покрыты — крипто конвертов в src/lib/familyKeys.test.ts,
// поведение комнаты в worker/familyRoom.test.ts. Но контракт между ними ничем
// не проверялся, а именно там ошибка обходится дороже всего: разойдись имя
// поля или порядок вызовов, и семейный чат сломается у всех разом в момент
// выката воркера.
//
// Поэтому здесь берутся обе реализации как есть: клиентские функции из
// familyKeys.ts и Durable Object из worker/src/familyRoom.js поверх
// node:sqlite. Подменяется ровно транспорт — глобальный fetch направляется в
// комнату вместо сети. Крипто настоящее (WebCrypto), база настоящая (Dexie
// поверх fake-indexeddb).

import 'fake-indexeddb/auto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { FamilyRoom } = await import('../../../worker/src/familyRoom.js');
const { db } = await import('../../db/db');
const { generateKey, exportKeyRaw, importKeyRaw, encryptJSON, newAccountId, randomToken } =
  await import('../crypto');
const {
  adoptSealedKey,
  decFamily,
  encFamily,
  ensureBoxKeys,
  planRemoval,
  recoverAccess,
  registerMember,
  removeMember,
  resendKeys,
  KeyDeliveryError,
  NotOwnerError,
} = await import('./familyKeys');
const { getFamilyConfig, patchFamilyConfig } = await import('./familyState');

// === Комната на node:sqlite, доступная через подменённый fetch ===

const FAMILY_ID = 'fam-1';
let room: InstanceType<typeof FamilyRoom>;
let sockets: { memberId: string | null; closed: number | null; sent: string[] }[] = [];

function bootRoom() {
  const sdb = new DatabaseSync(':memory:');
  sockets = [];
  const sql = {
    exec(query: string, ...params: unknown[]) {
      if (params.length === 0 && /;\s*\S/.test(query.trim())) {
        sdb.exec(query);
        return { toArray: () => [] };
      }
      const st = sdb.prepare(query);
      const rows = /^\s*SELECT/i.test(query)
        ? st.all(...(params as never[]))
        : (st.run(...(params as never[])), []);
      return { toArray: () => rows };
    },
  };
  room = new FamilyRoom(
    {
      storage: { sql, setAlarm: () => Promise.resolve() },
      getWebSockets: () => sockets,
      waitUntil: (p: Promise<unknown>) => void p,
      acceptWebSocket: () => {},
    },
    {},
  );
}

const realFetch = globalThis.fetch;

function routeToRoom() {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    if (!url.includes('/family/')) return realFetch(input as RequestInfo, init);
    return room.fetch(new Request(url, init));
  }) as typeof fetch;
}

// === Заведение участников ===

async function makeMember(opts: { owner?: boolean; token: string }) {
  const memberId = newAccountId();
  const key = await importKeyRaw(opts.token === '' ? await exportKeyRaw(await generateKey()) : GROUP_KEY_RAW);
  await db.family.put({
    id: FAMILY_ID,
    familyId: FAMILY_ID,
    familyToken: opts.token,
    familyKey: key,
    familyName: 'Семья',
    selfMemberId: memberId,
    lastSeq: 0,
    lastReadSeq: 0,
    enabled: true,
    joinedAt: new Date().toISOString(),
    keyEpoch: 0,
    keyRing: { '0': key },
    ...(opts.owner ? { ownerSecret: randomToken(), ownerMemberId: memberId } : {}),
  });
  const c = await ensureBoxKeys((await getFamilyConfig(FAMILY_ID))!);
  await registerMember(FAMILY_ID);
  // Публичный ключ участника живёт в шифрованном канале 'member'; здесь пишем
  // его прямо в локальную таблицу — транспорт канала не предмет этого теста.
  await db.familyMembers.put({
    id: memberId,
    familyId: FAMILY_ID,
    seq: 1,
    displayName: memberId.slice(0, 4),
    color: '#888',
    joinedAt: new Date().toISOString(),
    leftAt: null,
    boxPub: c.boxPub,
    removedAt: null,
  });
  return memberId;
}

/** Снимок конфига участника: в базе живёт ОДНА строка family, а участников в
 *  тесте несколько. Переключаемся между ними, сохраняя и восстанавливая её. */
type Snapshot = Awaited<ReturnType<typeof getFamilyConfig>>;
async function snapshot(): Promise<Snapshot> {
  return getFamilyConfig(FAMILY_ID);
}
async function restore(s: Snapshot) {
  if (s) await db.family.put(s);
}

let GROUP_KEY_RAW = '';
const TOKEN = 'group-token-1';

describe('исключение участника: клиент против сервера', () => {
  let ownerCfg: Snapshot;
  let aliceCfg: Snapshot;
  let kickedCfg: Snapshot;
  let ownerId = '';
  let aliceId = '';
  let kickedId = '';

  beforeEach(async () => {
    bootRoom();
    routeToRoom();
    await db.family.clear();
    await db.familyMembers.clear();
    GROUP_KEY_RAW = await exportKeyRaw(await generateKey());

    ownerId = await makeMember({ owner: true, token: TOKEN });
    ownerCfg = await snapshot();
    aliceId = await makeMember({ token: TOKEN });
    aliceCfg = await snapshot();
    kickedId = await makeMember({ token: TOKEN });
    kickedCfg = await snapshot();
    // Каждый участник узнал публичные ключи остальных — так их разносит канал
    // 'member' в работающем приложении.
    await restore(ownerCfg);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('владелец исключает: остальные получают новый ключ, исключённый — нет', async () => {
    const plan = await removeMember(FAMILY_ID, kickedId);
    expect(plan.stranded).toEqual([]);
    expect(plan.keeping.map((m) => m.id).sort()).toEqual([aliceId, ownerId].sort());

    const afterOwner = (await snapshot())!;
    expect(afterOwner.keyEpoch).toBe(1);
    expect(afterOwner.familyToken).not.toBe(TOKEN);
    // Старый ключ никуда не делся — прошлая переписка обязана читаться.
    expect(Object.keys(afterOwner.keyRing!).sort()).toEqual(['0', '1']);

    // Сообщение, написанное уже после исключения.
    const secret = await encFamily(afterOwner, { text: 'после исключения' });
    expect(secret.startsWith('e1.')).toBe(true);

    // Алиса была офлайн: приходит со старым токеном и восстанавливает доступ.
    await restore(aliceCfg);
    expect(await recoverAccess(FAMILY_ID)).toBe(true);
    const alice = (await snapshot())!;
    expect(alice.keyEpoch).toBe(1);
    expect(alice.familyToken).toBe(afterOwner.familyToken);
    await expect(decFamily(alice, secret)).resolves.toEqual({ text: 'после исключения' });

    // Исключённый: конверта ему нет, ключ остался старый, сообщение не читается.
    await restore(kickedCfg);
    expect(await recoverAccess(FAMILY_ID)).toBe(false);
    const kicked = (await snapshot())!;
    expect(kicked.keyEpoch ?? 0).toBe(0);
    await expect(decFamily(kicked, secret)).rejects.toThrow();
  });

  it('исключённому отвечают 403, а не 401', async () => {
    // Разница принципиальная. 401 значит «токен устарел, забери новый конверт»,
    // и приложение честно уходит в цикл переподключений. Исключённому нужен
    // отдельный ответ, иначе он до скончания века видит «подключение…» и не
    // узнаёт, что произошло.
    await removeMember(FAMILY_ID, kickedId);
    await restore(kickedCfg);
    const res = await fetch(
      `https://x/family/ticket?familyId=${FAMILY_ID}&memberId=${kickedId}`,
      { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(403);
  });

  it('оставшемуся со старым токеном отвечают 401 — ему есть что забрать', async () => {
    await removeMember(FAMILY_ID, kickedId);
    await restore(aliceCfg);
    const res = await fetch(
      `https://x/family/ticket?familyId=${FAMILY_ID}&memberId=${aliceId}`,
      { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(401);
  });

  it('прошлая переписка остаётся читаемой после смены ключа', async () => {
    // Ради этого и держится связка ключей: иначе исключение кого-то одного
    // превратило бы всю историю группы в нечитаемые записи у всех остальных.
    const before = (await snapshot())!;
    const oldMessage = await encFamily(before, { text: 'до исключения' });
    await removeMember(FAMILY_ID, kickedId);
    const after = (await snapshot())!;
    await expect(decFamily(after, oldMessage)).resolves.toEqual({ text: 'до исключения' });
  });

  it('не владелец исключить не может', async () => {
    await restore(aliceCfg);
    await expect(removeMember(FAMILY_ID, kickedId)).rejects.toThrow(NotOwnerError);
  });

  it('участник без публичного ключа назван до подтверждения, а не после', async () => {
    // Старая версия приложения: ключа нет, передать новый нечем. Человек должен
    // узнать об этом до нажатия, иначе он просто потеряет двоих вместо одного.
    await db.familyMembers.update(aliceId, { boxPub: undefined });
    const plan = await planRemoval(FAMILY_ID, kickedId);
    expect(plan.stranded.map((m) => m.id)).toEqual([aliceId]);
    expect(plan.keeping.map((m) => m.id)).toEqual([ownerId]);
  });

  it('повторное исключение поднимает эпоху ещё раз', async () => {
    await removeMember(FAMILY_ID, kickedId);
    const mid = (await snapshot())!;
    const midMessage = await encFamily(mid, { text: 'между исключениями' });
    await removeMember(FAMILY_ID, aliceId);
    const end = (await snapshot())!;
    expect(end.keyEpoch).toBe(2);
    expect(Object.keys(end.keyRing!).sort()).toEqual(['0', '1', '2']);
    await expect(decFamily(end, midMessage)).resolves.toEqual({ text: 'между исключениями' });
  });

  it('чужой конверт не принимается', async () => {
    // Сервер подменил конверт своим, чтобы навязать участнику известный себе
    // ключ. Проверка отправителя — дериватор с публичным ключом владельца.
    await removeMember(FAMILY_ID, kickedId);
    await restore(aliceCfg);
    const fakeKey = await generateKey();
    const fake = await encryptJSON(fakeKey, { epoch: 9, keyRaw: 'x', familyToken: 'y' });
    expect(await adoptSealedKey(FAMILY_ID, fake)).toBe(false);
    expect((await snapshot())!.keyEpoch ?? 0).toBe(0); // ключ не тронут
  });

  it('устаревший конверт не откатывает ключ назад', async () => {
    // Конверт первой эпохи мог долежать до второй. Принять его — значит
    // потерять доступ к свежей переписке.
    await removeMember(FAMILY_ID, kickedId);
    const sealedFirst = await (
      await fetch(`https://x/family/keys?familyId=${FAMILY_ID}&member=${aliceId}`)
    ).json();
    await restore(aliceCfg);
    expect(await adoptSealedKey(FAMILY_ID, sealedFirst.sealed)).toBe(true);
    await patchFamilyConfig(FAMILY_ID, { keyEpoch: 5 }); // ушли вперёд
    expect(await adoptSealedKey(FAMILY_ID, sealedFirst.sealed)).toBe(false);
  });
  // === Половинчатые состояния: что остаётся, когда шаг не прошёл ===
  //
  // Ровно этот класс дефектов девять тестов выше пропускали целиком: они
  // проверяют удачный путь, а рвётся всё на неудачном. Ниже — обрыв на каждом
  // из двух сетевых шагов, и требование одно: группа не должна разваливаться
  // необратимо.

  /** Пропускать в комнату всё, кроме указанного пути: он «не доехал». */
  function breakRoute(path: string, status = 0) {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes(path)) {
        // status 0 — обрыв связи, как при отказе CORS: не ответ, а исключение.
        if (status === 0) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(new Response('{}', { status }));
      }
      if (!url.includes('/family/')) return realFetch(input as RequestInfo, init);
      return room.fetch(new Request(url, init));
    }) as typeof fetch;
  }

  it('обрыв на /remove не трогает НИКОГО: ни владельца, ни остальных', async () => {
    // Было наоборот и стоило группы. Конверты раскладывались первыми, сервер
    // тут же рассылал их по сокетам, и все онлайн молча переходили на ключ,
    // о котором сервер ещё не знал. Не пройди следом /remove — владелец и
    // сервер на старом токене, остальные на новом: вечный реконнект и выход
    // только по новому приглашению, с потерей переписки.
    breakRoute('/family/remove');
    await expect(removeMember(FAMILY_ID, kickedId)).rejects.toThrow();

    // Владелец там же, где был.
    const owner = await snapshot();
    expect(owner!.keyEpoch ?? 0).toBe(0);
    expect(owner!.familyToken).toBe(TOKEN);

    // И, главное, конвертов не появилось — значит Алисе нечего принимать и
    // некуда уехать вперёд сервера.
    routeToRoom();
    const got = await (
      await fetch(`https://x/family/keys?familyId=${FAMILY_ID}&member=${aliceId}`)
    ).json();
    expect(got.sealed).toBeNull();

    await restore(aliceCfg);
    expect((await snapshot())!.familyToken).toBe(TOKEN);
  });

  it('без связи и при отказе сервера причина видна словами, а не «Failed to fetch» или кодом', async () => {
    // Текст ошибки «Исключить» и «Удалить группу» экран показывает как есть.
    // Без сети туда уходило исключение fetch — «Failed to fetch», а на отказ
    // сервера — «сервер отказал в исключении (500)»: мимо словаря и с кодом.
    breakRoute('/family/');
    await expect(removeMember(FAMILY_ID, kickedId)).rejects.toThrow('Нет связи с сервером');
    const { deleteFamily } = await import('./familyLifecycle');
    await expect(deleteFamily(FAMILY_ID)).rejects.toThrow('Нет связи с сервером');

    breakRoute('/family/remove', 500);
    await expect(removeMember(FAMILY_ID, kickedId)).rejects.toThrow('Не удалось исключить участника');
    breakRoute('/family/remove', 403);
    await expect(removeMember(FAMILY_ID, kickedId)).rejects.toThrow(NotOwnerError);
  });

  it('конверты не дошли: исключение состоялось, а не откатилось, и чинится повтором', async () => {
    breakRoute('/family/send');
    // Ошибка отдельного класса: переигрывать исключение не надо, надо повторить
    // раздачу. Общее «не удалось исключить» толкало бы жать кнопку заново и
    // крутить лишнюю эпоху ключа на каждый тап.
    await expect(removeMember(FAMILY_ID, kickedId)).rejects.toThrow(KeyDeliveryError);

    // Владелец уже на новом ключе — иначе он остался бы со старым токеном,
    // который сервер только что перестал принимать, то есть заперт снаружи
    // собственной группы.
    const owner = await snapshot();
    expect(owner!.keyEpoch).toBe(1);
    expect(owner!.familyToken).not.toBe(TOKEN);

    // Сервер тоже сменил токен: старый больше не пускает.
    routeToRoom();
    const old = await room.fetch(
      new Request(`https://x/family/ticket?familyId=${FAMILY_ID}&memberId=${aliceId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(old.status).toBe(401);

    // Повтор раздачи возвращает Алису — состояние чинится, а не заперто.
    const ownerNow = await snapshot();
    await restore(ownerNow);
    expect(await resendKeys(FAMILY_ID)).toEqual([]);
    await restore(aliceCfg);
    expect(await recoverAccess(FAMILY_ID)).toBe(true);
    expect((await snapshot())!.familyToken).toBe(owner!.familyToken);
  });

  it('конверт своей эпохи принимается, если токен разошёлся с серверным', async () => {
    // Страховка на случай, когда ключ приняли, а токен всё равно не подходит.
    // Без неё единственный конверт, способный вернуть устройство, отбрасывался
    // бы как «старьё», и оно осталось бы запертым навсегда.
    await removeMember(FAMILY_ID, kickedId);
    const sealed = (
      await (await fetch(`https://x/family/keys?familyId=${FAMILY_ID}&member=${aliceId}`)).json()
    ).sealed;
    await restore(aliceCfg);
    expect(await adoptSealedKey(FAMILY_ID, sealed)).toBe(true);
    const good = (await snapshot())!.familyToken;

    // Токен разъехался, эпоха прежняя.
    await patchFamilyConfig(FAMILY_ID, { familyToken: 'разошёлся' });
    expect(await adoptSealedKey(FAMILY_ID, sealed)).toBe(true);
    expect((await snapshot())!.familyToken).toBe(good);

    // А повторный приём того же конверта при СОВПАДАЮЩЕМ токене — по-прежнему
    // нет: иначе тест выше про «устаревший конверт» ничего бы не значил.
    expect(await adoptSealedKey(FAMILY_ID, sealed)).toBe(false);
  });
  it('пропустивший ДВЕ смены ключа читает всю переписку, а не половину', async () => {
    // Конверт на сервере один на участника: второе исключение перезаписывает
    // конверт первого. Раньше внутри лежал ровно ОДИН ключ, и тот, кто был
    // офлайн во время обоих исключений, забирал только последний — сообщения
    // между двумя исключениями у него не расшифровывались уже никогда. Теперь
    // конверт несёт всю связку эпох, как это давно сделано в приглашении.
    const aliceBefore = aliceCfg;

    // Нужен четвёртый: исключить дважды можно только двух разных людей, а
    // владельца исключать нельзя.
    const bobId = await makeMember({ token: TOKEN });
    await restore(ownerCfg);

    // Исключение №1 → эпоха 1. Алисы в сети нет, конверт она не забирает.
    await removeMember(FAMILY_ID, kickedId);
    const ownerE1 = (await snapshot())!;
    expect(ownerE1.keyEpoch).toBe(1);
    const secretE1 = await encFamily(ownerE1, { text: 'между двумя исключениями' });

    // Исключение №2 → эпоха 2. Конверт Алисы перезаписан вторым.
    await removeMember(FAMILY_ID, bobId);
    expect((await snapshot())!.keyEpoch).toBe(2);

    // Алиса возвращается и забирает единственный оставшийся конверт.
    const sealed = (
      await (await fetch(`https://x/family/keys?familyId=${FAMILY_ID}&member=${aliceId}`)).json()
    ).sealed;
    await restore(aliceBefore);
    expect(await adoptSealedKey(FAMILY_ID, sealed)).toBe(true);
    expect((await snapshot())!.keyEpoch).toBe(2);

    // И читает сообщение ПРОПУЩЕННОЙ эпохи 1 — ключ приехал в связке.
    const aliceNow = (await snapshot())!;
    await expect(decFamily<{ text: string }>(aliceNow, secretE1)).resolves.toEqual({
      text: 'между двумя исключениями',
    });
  });
});

describe('удаление группы: клиент против сервера', () => {
  beforeEach(async () => {
    bootRoom();
    routeToRoom();
    await db.family.clear();
    await db.familyMembers.clear();
    GROUP_KEY_RAW = await exportKeyRaw(await generateKey());
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Жива ли группа на сервере — по истории: тикет без ответа на задачу сервер
  // не выдаёт вовсе, а история отвечает на один токен.
  const alive = (token: string) =>
    fetch(`https://w/family/messages?familyId=${FAMILY_ID}&since=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  it('создатель удаляет: у него группа исчезает, остальным сервер отвечает «удалена»', async () => {
    await makeMember({ token: TOKEN });
    await makeMember({ owner: true, token: TOKEN });
    const { deleteFamily } = await import('./familyLifecycle');

    await deleteFamily(FAMILY_ID);

    expect(await getFamilyConfig(FAMILY_ID)).toBeFalsy();
    // 410, а не 401: по 401 приложение участника полезло бы за новым ключом
    // и переподключалось бы вечно, так и не сказав, что группы больше нет.
    expect((await alive(TOKEN)).status).toBe(410);
  });

  it('с чужим секретом сервер отказывает, и группа остаётся цела', async () => {
    await makeMember({ owner: true, token: TOKEN });
    await makeMember({ token: TOKEN });
    // Участник подделал себе секрет владельца — сервер его не примет.
    await patchFamilyConfig(FAMILY_ID, { ownerSecret: randomToken() });
    const { deleteFamily } = await import('./familyLifecycle');

    await expect(deleteFamily(FAMILY_ID)).rejects.toThrow('Удалить группу может только её создатель');

    expect(await getFamilyConfig(FAMILY_ID)).toBeTruthy();
    expect((await alive(TOKEN)).status).toBe(200);
  });
});

// === Права в комнате: что клиент обязан прислать серверу ===
//
// Аудит 18.11 (S1, S3, S6): сервер верил memberId, который называет сам
// клиент. Сервер перестаёт верить — и тогда каждый честный запрос обязан нести
// доказательство: привязанный тикет, секрет владельца на конвертах, ответ на
// задачу у подписки на уведомления. Клиент выкатывается ПЕРВЫМ, поэтому здесь
// проверяется именно он — против сервера, который пока ещё всё принимает.

describe('права в комнате: клиент несёт доказательства', () => {
  type Seen = { path: string; headers: Headers; body: Record<string, unknown> | null; res: unknown };
  let seen: Seen[] = [];

  /** Тот же маршрут в комнату, но с записью: что ушло и что вернулось. */
  function recordRoute() {
    seen = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (!url.includes('/family/')) return realFetch(input as RequestInfo, init);
      const req = new Request(url, init);
      const entry: Seen = {
        path: new URL(url).pathname,
        headers: req.headers,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
        res: null,
      };
      seen.push(entry);
      const res = await room.fetch(req);
      entry.res = await res.clone().json().catch(() => null);
      return res;
    }) as typeof fetch;
  }

  class FakeWS {
    static last: FakeWS | null = null;
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    url: string;
    constructor(url: string) {
      this.url = url;
      FakeWS.last = this;
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }

  beforeEach(async () => {
    bootRoom();
    recordRoute();
    await db.family.clear();
    await db.familyMembers.clear();
    GROUP_KEY_RAW = await exportKeyRaw(await generateKey());
    FakeWS.last = null;
    vi.stubGlobal('WebSocket', FakeWS);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
  });

  it('давно не открывавшееся устройство с первого же подключения получает привязанный тикет', async () => {
    // Группа на сервере есть, а у этого устройства ни пары ключей, ни
    // регистрации: вошло до появления ключей и с тех пор не открывалось.
    await makeMember({ owner: true, token: TOKEN });
    const memberId = newAccountId();
    const key = await importKeyRaw(GROUP_KEY_RAW);
    await db.family.put({
      id: FAMILY_ID, familyId: FAMILY_ID, familyToken: TOKEN, familyKey: key, familyName: 'Семья',
      selfMemberId: memberId, lastSeq: 0, lastReadSeq: 0, enabled: true,
      joinedAt: new Date().toISOString(), keyEpoch: 0, keyRing: { '0': key },
    });
    seen = [];
    const { connectFamily, disconnectFamily } = await import('./familyChat');
    connectFamily(FAMILY_ID);
    for (let i = 0; i < 200 && !FakeWS.last; i++) await new Promise((r) => setTimeout(r, 10));
    disconnectFamily(FAMILY_ID);

    const paths = seen.map((s) => s.path.replace('/family/', ''));
    // Регистрация раньше тикета: задачу сервер задаёт по уже известному ключу.
    expect(paths.indexOf('register'), 'ключ не зарегистрирован до тикета').toBeGreaterThan(-1);
    expect(paths.indexOf('register')).toBeLessThan(paths.indexOf('ticket'));
    const ticket = seen.find((s) => s.path.endsWith('/ticket'));
    expect((ticket?.res as { bound?: boolean })?.bound, 'тикет без привязки к участнику').toBe(true);
    // Подтверждённая пара отмечена — синк отдаст её другим моим устройствам.
    await new Promise((r) => setTimeout(r, 20));
    expect((await getFamilyConfig(FAMILY_ID))?.boxVerifiedAt, 'пара не отмечена подтверждённой').toBeTruthy();
  });

  it('конверты с новым ключом владелец кладёт со своим секретом', async () => {
    await makeMember({ owner: true, token: TOKEN });
    const owner = await snapshot();
    const kickedId = await makeMember({ token: TOKEN });
    await restore(owner);
    seen = [];
    await removeMember(FAMILY_ID, kickedId);
    const sends = seen.filter((s) => s.path.endsWith('/send'));
    expect(sends.length).toBeGreaterThan(0);
    for (const s of sends) {
      expect(s.headers.get('X-Family-Owner'), 'конверт без секрета владельца').toBe(owner!.ownerSecret);
    }
  });

  it('подписка на уведомления несёт ответ на задачу сервера, а не одно имя', async () => {
    await makeMember({ owner: true, token: TOKEN });
    const store = new Map<string, string>([['life-hub-push-sub', JSON.stringify({ endpoint: 'https://push.example/me' })]]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    seen = [];
    const { registerAllFamilyPush } = await import('./familyChat');
    await registerAllFamilyPush();

    const sub = seen.find((s) => s.path.endsWith('/push-sub'));
    expect(sub, 'подписка не ушла').toBeTruthy();
    const { challengeId, nonce } = (sub!.body ?? {}) as { challengeId?: string; nonce?: string };
    expect(challengeId, 'в подписке нет ответа на задачу').toBeTruthy();
    // Ответ верный: слово совпадает с тем, что сервер запечатал ключом участника.
    const row = (room as unknown as { sql: { exec: (q: string, ...p: unknown[]) => { toArray: () => { v: string }[] } } }).sql
      .exec('SELECT v FROM meta WHERE k=?', `chal:${challengeId}`)
      .toArray()[0];
    if (row) expect(JSON.parse(row.v).nonce).toBe(nonce);
    else expect(nonce).toBeTruthy(); // сервер уже погасил задачу, приняв ответ
  });

  // Аудит 18.11, S1/F1 — проба keyhijack: участник подменяет профиль Алисы
  // своим вторым публичным ключом. Владелец после его исключения печатает
  // «конверт Алисы» на этот ключ: исключённый читает дальше, Алиса молча
  // теряет группу. Здесь настоящий клиент владельца принимает историю комнаты
  // настоящим кодом приёма и настоящим removeMember исключает злоумышленника.
  it('подменить чужой профиль нельзя — исключённый не получает новый ключ, Алиса не теряет группу', async () => {
    const { connectFamily, disconnectFamily } = await import('./familyChat');
    const crypto_ = await import('../crypto');
    await makeMember({ owner: true, token: TOKEN });
    const ownerCfg = (await snapshot())!;
    const aliceId = await makeMember({ token: TOKEN });
    const aliceCfg = (await snapshot())!;
    const malloryId = await makeMember({ token: TOKEN });
    const malloryCfg = (await snapshot())!;
    // Сокеты в комнате — как их открывает воркер по привязанным тикетам.
    const socketOf = (memberId: string) => {
      const s = { memberId, closed: null as number | null, sent: [] as string[], att: { memberId, bound: true } as Record<string, unknown> };
      Object.assign(s, {
        deserializeAttachment: () => s.att,
        serializeAttachment: (a: Record<string, unknown>) => void (s.att = a),
        send: (f: string) => void s.sent.push(f),
        close: (code: number) => void (s.closed = code),
      });
      sockets.push(s);
      return s;
    };
    const wsFrame = (sock: unknown, f: object) =>
      (room as unknown as { webSocketMessage: (w: unknown, raw: string) => Promise<void> }).webSocketMessage(sock, JSON.stringify(f));

    // Настоящий профиль Алисы — его публикует её приложение.
    const aliceProfile = (await db.familyMembers.get(aliceId))!;
    await wsFrame(socketOf(aliceId), { type: 'send', channel: 'member', itemId: aliceId, ciphertext: await encFamily(aliceCfg, aliceProfile) });

    // Подделка: профиль Алисы со вторым ключом злоумышленника.
    const m2 = await crypto_.generateBoxKeyPair();
    const poisoned = await encFamily(malloryCfg, { ...aliceProfile, boxPub: await crypto_.exportBoxPublic(m2.publicKey) });
    const viaHttp = await fetch(`https://w/family/send?familyId=${FAMILY_ID}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'member', itemId: aliceId, senderMemberId: aliceId, ciphertext: poisoned }),
    });
    expect(viaHttp.status, 'подмена по HTTP принята').toBe(403);
    const mallorySock = socketOf(malloryId);
    await wsFrame(mallorySock, { type: 'send', channel: 'member', itemId: aliceId, senderMemberId: aliceId, ciphertext: poisoned });
    expect(mallorySock.sent.map((f) => JSON.parse(f).type), 'подмена по сокету принята').toEqual(['nack']);

    // Телефон владельца принимает историю комнаты настоящим кодом приёма.
    await restore(ownerCfg);
    await db.familyMembers.delete(aliceId);
    connectFamily(FAMILY_ID);
    for (let i = 0; i < 200 && !FakeWS.last; i++) await new Promise((r) => setTimeout(r, 10));
    const sock = FakeWS.last!;
    sock.readyState = 1;
    sock.onopen?.();
    const hist = (await (await fetch(`https://w/family/messages?familyId=${FAMILY_ID}&since=0`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()) as { items: unknown[] };
    await sock.onmessage?.({ data: JSON.stringify({ type: 'backfill', items: hist.items, hasMore: false }) });
    disconnectFamily(FAMILY_ID);
    expect((await db.familyMembers.get(aliceId))?.boxPub, 'у владельца ключ Алисы подменён').toBe(aliceCfg.boxPub);

    // Владелец исключает злоумышленника.
    await removeMember(FAMILY_ID, malloryId);
    const ownerAfter = (await snapshot())!;
    expect(ownerAfter.keyEpoch).toBe(1);

    // Злоумышленник забирает «конверт Алисы» и не открывает его своим ключом.
    const sealed = ((await (await fetch(`https://w/family/keys?familyId=${FAMILY_ID}&member=${aliceId}`)).json()) as { sealed: string }).sealed;
    await expect(
      crypto_.openFrom(await crypto_.importBoxPublic(ownerCfg.boxPub!), m2.privateKey, sealed),
      'исключённый открыл конверт Алисы',
    ).rejects.toThrow();

    // А Алиса, вернувшись со старым токеном, свой конверт открывает.
    await restore(aliceCfg);
    expect(await recoverAccess(FAMILY_ID), 'Алиса потеряла группу').toBe(true);
    expect((await snapshot())!.familyToken).toBe(ownerAfter.familyToken);
  });
});
