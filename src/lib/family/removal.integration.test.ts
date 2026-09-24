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

  const ticket = (token: string) =>
    fetch(`https://w/family/ticket?familyId=${FAMILY_ID}`, {
      method: 'POST',
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
    expect((await ticket(TOKEN)).status).toBe(410);
  });

  it('с чужим секретом сервер отказывает, и группа остаётся цела', async () => {
    await makeMember({ owner: true, token: TOKEN });
    await makeMember({ token: TOKEN });
    // Участник подделал себе секрет владельца — сервер его не примет.
    await patchFamilyConfig(FAMILY_ID, { ownerSecret: randomToken() });
    const { deleteFamily } = await import('./familyLifecycle');

    await expect(deleteFamily(FAMILY_ID)).rejects.toThrow('Удалить группу может только её создатель');

    expect(await getFamilyConfig(FAMILY_ID)).toBeTruthy();
    expect((await ticket(TOKEN)).status).toBe(200);
  });
});
