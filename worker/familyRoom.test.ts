// Тест серверной части исключения участника.
//
// FamilyRoom — Durable Object, и целиком его в Node не поднять. Но вся логика
// доступа живёт в SQL и в проверках внутри fetch(), а SQL здесь обычный
// SQLite — его даёт node:sqlite. Поэтому подменяются ровно две вещи: базовый
// класс DurableObject и хранилище. Сам файл familyRoom.js импортируется как
// есть, без правок под тест: иначе проверялась бы копия, а не то, что поедет.

import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Заглушка модуля, которого вне Workers не существует. Настоящий DurableObject
// раскладывает аргументы конструктора в this.ctx/this.env — без этого код
// комнаты не найдёт ни сокетов, ни секретов.
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

const { FamilyRoom } = await import('./src/familyRoom.js');

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface FakeSocket {
  memberId: string | null;
  /** Вложение целиком, как его хранит настоящий сокет: не только memberId, но
   *  и признак подтверждённой личности. Раньше двойник помнил одно имя — и
   *  проверка подмены проходила «успешно» просто потому, что признак терялся
   *  по дороге. */
  att: Record<string, unknown> | null;
  closed: { code: number; reason: string } | null;
  sent: string[];
}

function makeRoom() {
  const db = new DatabaseSync(':memory:');
  const sockets: FakeSocket[] = [];
  const sql = {
    exec(query: string, ...params: unknown[]) {
      // exec() в Workers принимает и несколько выражений подряд (CREATE TABLE в
      // конструкторе), и одиночный запрос с параметрами.
      if (params.length === 0 && /;\s*\S/.test(query.trim())) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const st = db.prepare(query);
      const rows = /^\s*SELECT/i.test(query) ? st.all(...(params as never[])) : (st.run(...(params as never[])), []);
      return { toArray: () => rows };
    },
  };
  const ctx = {
    storage: { sql, setAlarm: () => Promise.resolve() },
    getWebSockets: () => sockets,
    waitUntil: (p: Promise<unknown>) => void p,
    acceptWebSocket: () => {},
  };
  const room = new FamilyRoom(ctx, {});
  const addSocket = (memberId: string | null): FakeSocket => {
    // Сокет с именем — как его открывает воркер по привязанному тикету:
    // личность подтверждена задачей. Без имени — соединение без подтверждения
    // (такие остались бы от прежней версии до выката).
    const s: FakeSocket = { memberId, att: memberId ? { memberId, bound: true } : null, closed: null, sent: [] };
    sockets.push(
      Object.assign(s, {
        deserializeAttachment: () => s.att,
        serializeAttachment: (a: Record<string, unknown>) => {
          s.att = a;
          s.memberId = (a?.memberId as string | null) ?? null;
        },
        close: (code: number, reason: string) => {
          s.closed = { code, reason };
        },
        send: (f: string) => s.sent.push(f),
      }) as unknown as FakeSocket,
    );
    return s;
  };
  const call = (
    path: string,
    { method = 'GET', token = '', body, headers = {} }: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    room.fetch(
      new Request(`https://x/family/${path}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return { room, call, addSocket };
}

// Значения ASCII: токен и секрет владельца едут HTTP-заголовками, а туда
// кириллица не проходит вовсе. В приложении оба — base64url (randomToken).
const TOKEN = 'token-group-1';
const OWNER_SECRET = 'owner-secret-1';
const OWNER = 'owner-1';
const ALICE = 'alice-1';
const KICKED = 'kicked-1';

const cryptoLib = await import('../src/lib/crypto');

type Room = ReturnType<typeof makeRoom>;

/** Участник с настоящей парой ключей: регистрирует публичный, а на задачу
 *  сервера отвечает приватным — как это делает приложение. */
async function enroll(r: Room, memberId: string, extra: Record<string, unknown> = {}) {
  const pair = await cryptoLib.generateBoxKeyPair();
  const pub = await cryptoLib.exportBoxPublic(pair.publicKey);
  const priv = await cryptoLib.exportBoxPrivate(pair.privateKey);
  await r.call('register', { method: 'POST', token: TOKEN, body: { memberId, boxPub: pub, ...extra } });
  return { pub, priv };
}

/** Ответ на задачу: доказательство «я и есть memberId». null — задачи нет. */
async function answer(r: Room, memberId: string, priv: string, token = TOKEN) {
  const res = await r.call('challenge', { method: 'POST', token, body: { memberId } });
  if (!res.ok) return null;
  const { challenge } = (await res.json()) as { challenge: { challengeId: string; ephPub: string; sealed: string } | null };
  if (!challenge) return null;
  const { nonce } = await cryptoLib.openFrom<{ nonce: string }>(
    await cryptoLib.importBoxPublic(challenge.ephPub),
    await cryptoLib.importBoxPrivate(priv),
    challenge.sealed,
  );
  return { challengeId: challenge.challengeId, nonce };
}

async function setup() {
  const r = makeRoom();
  // Первый запрос закрепляет токен группы (TOFU).
  const keys: Record<string, { pub: string; priv: string }> = {};
  keys[OWNER] = await enroll(r, OWNER, { ownerSecretHash: await sha256hex(OWNER_SECRET) });
  for (const id of [ALICE, KICKED]) keys[id] = await enroll(r, id);
  return { ...r, keys };
}

async function remove(r: Awaited<ReturnType<typeof setup>>, memberId: string, newToken: string, secret = OWNER_SECRET) {
  return r.call('remove', {
    method: 'POST',
    token: TOKEN,
    headers: { 'X-Family-Owner': secret },
    body: { memberId, newTokenHash: await sha256hex(newToken) },
  });
}

/** Конверт с ключом группы — как его кладёт владелец (resendKeys). */
function putKey(r: Room, member: string, ciphertext: string, secret: string | null = OWNER_SECRET) {
  return r.call('send', {
    method: 'POST',
    token: TOKEN,
    headers: secret ? { 'X-Family-Owner': secret } : {},
    body: { channel: 'key', itemId: member, ciphertext },
  });
}

type WireItem = { seq: number; channel: string; itemId: string; senderMemberId: string | null; ciphertext: string };
async function history(r: Room, token = TOKEN): Promise<WireItem[]> {
  return ((await (await r.call('messages?since=0', { token })).json()) as { items: WireItem[] }).items;
}

/** Кадр от сокета — так, как его принимает воркер. */
function frame(r: Room, ws: FakeSocket, f: Record<string, unknown>) {
  return (r.room as unknown as { webSocketMessage: (w: unknown, raw: string) => Promise<void> }).webSocketMessage(ws, JSON.stringify(f));
}
const framesOf = (ws: FakeSocket) => ws.sent.map((f) => JSON.parse(f) as Record<string, unknown>);

describe('владелец группы', () => {
  it('закрепляется за создателем и не переходит к следующему', async () => {
    const r = await setup();
    const res = await r.call('register', {
      method: 'POST',
      token: TOKEN,
      // Приглашённый секрета не знает, но может прислать свой — попытка захвата.
      body: { memberId: 'самозванец', boxPub: 'pub-x', ownerSecretHash: await sha256hex('grab-attempt') },
    });
    expect((await res.json()).owner).toBe(OWNER);
  });

  it('исключать может только он', async () => {
    const r = await setup();
    const res = await remove(r, ALICE, 'token-group-2', 'wrong-secret');
    expect(res.status).toBe(403);
  });

  it('сам себя исключить не может', async () => {
    // Иначе группа осталась бы без того, кто вправе кого-то исключать.
    const r = await setup();
    expect((await remove(r, OWNER, 'token-group-2')).status).toBe(400);
  });
});

describe('исключение участника', () => {
  let r: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    r = await setup();
  });

  it('старый токен перестаёт работать, новый работает', async () => {
    await remove(r, KICKED, 'token-group-2');
    expect((await r.call('messages?since=0', { token: TOKEN })).status).toBe(401);
    expect((await r.call('messages?since=0', { token: 'token-group-2' })).status).toBe(200);
  });

  it('исключённому не выдают тикет даже с верным токеном', async () => {
    // Он мог узнать новый токен другим путём — например, с ещё не отключённого
    // второго своего устройства. Пометка removed_at важнее токена.
    await remove(r, KICKED, 'token-group-2');
    const res = await r.call(`ticket?memberId=${KICKED}`, { method: 'POST', token: 'token-group-2' });
    expect(res.status).toBe(403);
    // И задачи на подтверждение личности ему не задают: ответить на неё он
    // сумел бы — ключ при нём.
    expect(await answer(r, KICKED, r.keys[KICKED].priv, 'token-group-2')).toBeNull();
  });

  it('исключённый не может зарегистрироваться заново под тем же id', async () => {
    await remove(r, KICKED, 'token-group-2');
    const res = await r.call('register', {
      method: 'POST',
      token: 'token-group-2',
      body: { memberId: KICKED, boxPub: 'pub-новый' },
    });
    expect(res.status).toBe(403);
  });

  it('пуши исключённому больше не уходят', async () => {
    const proof = await answer(r, KICKED, r.keys[KICKED].priv);
    await r.call('push-sub', { method: 'POST', token: TOKEN, body: { subscription: { endpoint: 'e' }, ...proof } });
    await remove(r, KICKED, 'token-group-2');
    const row = (r.room as unknown as { sql: { exec: (q: string, ...p: unknown[]) => { toArray: () => { push_sub: string | null }[] } } }).sql
      .exec('SELECT push_sub FROM members WHERE member_id=?', KICKED)
      .toArray()[0];
    expect(row.push_sub).toBeNull();
  });

  // Аудит 18.11, S2: исключённый заранее открыл второе соединение под чужим
  // именем — и оно переживало исключение: невидимое в «в сети», писало от
  // имени любого, в том числе владельца, и переименовывало группу.
  it('исключение рвёт ВСЕ соединения комнаты: запасное исключённого — тоже', async () => {
    const kicked = r.addSocket(KICKED);
    const alice = r.addSocket(ALICE);
    const owner = r.addSocket(OWNER);
    // Запасное соединение под другим именем: второй memberId со своим
    // ключом заводит любой, у кого есть токен, — и получает привязку.
    const ghost = r.addSocket('ghost-1');
    // И соединение без подтверждения, открытое прежней версией сервера.
    const legacy = r.addSocket(null);
    legacy.serializeAttachment({ memberId: OWNER, bound: false });

    await remove(r, KICKED, 'token-group-2');

    expect(kicked.closed).toEqual({ code: 4403, reason: 'removed' });
    for (const s of [alice, owner, ghost, legacy]) {
      // Не 4403 и не 4404: приложение переподключится уже с новым токеном.
      expect(s.closed?.code, 'соединение пережило смену токена').toBe(4401);
    }
    // Кто был в сети, узнал об исключении до закрытия соединения.
    expect(framesOf(alice).some((f) => f.type === 'removed' && f.memberId === KICKED)).toBe(true);
  });
});

async function deleteGroup(r: Awaited<ReturnType<typeof setup>>, secret = OWNER_SECRET) {
  return r.call('delete', { method: 'POST', token: TOKEN, headers: { 'X-Family-Owner': secret } });
}

describe('удаление группы', () => {
  let r: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    r = await setup();
  });

  it('удалить может только владелец — чужой секрет ничего не трогает', async () => {
    expect((await deleteGroup(r, 'wrong-secret')).status).toBe(403);
    expect((await r.call('messages?since=0', { token: TOKEN })).status).toBe(200);
  });

  it('живые соединения рвутся кодом «удалена», а не «исключён»', async () => {
    const a = r.addSocket(ALICE);
    const b = r.addSocket(KICKED);
    expect((await deleteGroup(r)).status).toBe(200);
    expect(a.closed).toEqual({ code: 4404, reason: 'deleted' });
    expect(b.closed).toEqual({ code: 4404, reason: 'deleted' });
  });

  it('после удаления комната отвечает 410 — клиент отличает это от исключения', async () => {
    await deleteGroup(r);
    expect((await r.call('messages?since=0', { token: TOKEN })).status).toBe(410);
    expect((await r.call('ticket', { method: 'POST', token: TOKEN })).status).toBe(410);
  });

  it('старым токеном пустую группу не пересоздать', async () => {
    // Без надгробия первый же register на пустой комнате закрепил бы токен
    // заново (TOFU), и вернувшийся офлайн-участник поднял бы группу из пепла.
    await deleteGroup(r);
    const res = await r.call('register', { method: 'POST', token: TOKEN, body: { memberId: ALICE, boxPub: 'pub-alice' } });
    expect(res.status).toBe(410);
  });

  it('тикет, выданный до удаления, сокет не открывает', async () => {
    const proof = await answer(r, ALICE, r.keys[ALICE].priv);
    const { ticket } = (await (await r.call('ticket', { method: 'POST', token: TOKEN, body: proof })).json()) as { ticket: string };
    expect(ticket).toBeTruthy();
    await deleteGroup(r);
    expect((await r.call(`ws?ticket=${ticket}`)).status).toBe(410);
  });

  it('конверты с ключами стираются вместе с группой', async () => {
    await putKey(r, ALICE, 'конверт-для-alice');
    expect(await (await r.call(`keys?member=${ALICE}`)).json()).toEqual({ sealed: 'конверт-для-alice' });
    await deleteGroup(r);
    expect(await (await r.call(`keys?member=${ALICE}`)).json()).toEqual({ sealed: null });
  });
});

describe('конверты с новым ключом', () => {
  it('отдаются без авторизации — иначе офлайн-участник заперт снаружи', async () => {
    // Он приходит со старым токеном: новый лежит как раз в конверте.
    const r = await setup();
    await putKey(r, ALICE, 'конверт-для-alice');
    await remove(r, KICKED, 'token-group-2');
    const res = await r.call(`keys?member=${ALICE}`);
    expect(await res.json()).toEqual({ sealed: 'конверт-для-alice' });
  });

  it('конверт исключённого исчезает при исключении', async () => {
    const r = await setup();
    await putKey(r, KICKED, 'конверт-для-исключённого');
    await remove(r, KICKED, 'token-group-2');
    expect(await (await r.call(`keys?member=${KICKED}`)).json()).toEqual({ sealed: null });
  });

  it('чужого конверта не существует', async () => {
    const r = await setup();
    expect(await (await r.call('keys?member=посторонний')).json()).toEqual({ sealed: null });
  });

  it('повторная рассылка заменяет прежний конверт, а не копит', async () => {
    const r = await setup();
    for (const ct of ['эпоха-1', 'эпоха-2']) await putKey(r, ALICE, ct);
    expect(await (await r.call(`keys?member=${ALICE}`)).json()).toEqual({ sealed: 'эпоха-2' });
  });

  // Аудит 18.11, S2 (по коду): по одному токену любой затирал чужой конверт
  // мусором, и тот, кто был офлайн во время исключения, оставался снаружи.
  it('кладёт только владелец: по токену и по сокету чужой конверт не затереть', async () => {
    const r = await setup();
    await putKey(r, ALICE, 'настоящий');
    expect((await putKey(r, ALICE, 'мусор', null)).status).toBe(403);
    expect((await putKey(r, ALICE, 'мусор', 'wrong-secret')).status).toBe(403);
    const ws = r.addSocket(KICKED);
    await frame(r, ws, { type: 'send', channel: 'key', itemId: ALICE, ciphertext: 'мусор' });
    expect(framesOf(ws).find((f) => f.type === 'nack')).toMatchObject({ itemId: ALICE });
    expect(await (await r.call(`keys?member=${ALICE}`)).json()).toEqual({ sealed: 'настоящий' });
  });
});

describe('публичный ключ участника', () => {
  it('закрепляется навсегда: подменить чужой нельзя', async () => {
    // Иначе тот, у кого есть токен группы, подменил бы ключ соседа своим и
    // получил бы адресованный тому конверт с ключом группы.
    const r = await setup();
    await r.call('register', { method: 'POST', token: TOKEN, body: { memberId: ALICE, boxPub: 'ключ-злодея' } });
    const rows = (r.room as unknown as { sql: { exec: (q: string, ...p: unknown[]) => { toArray: () => { box_pub: string }[] } } }).sql
      .exec('SELECT box_pub FROM members WHERE member_id=?', ALICE)
      .toArray();
    expect(rows[0].box_pub).toBe(r.keys[ALICE].pub);
  });
});

// Аудит 18.11, S3/F2/F3 и S1/F10: автор и право записи — по подтверждённой
// личности соединения, а не по тому, что прислал клиент.
describe('автор и право записи', () => {
  let r: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    r = await setup();
  });
  const msg = (clientMsgId: string, ciphertext: string, extra: Record<string, unknown> = {}) => ({
    type: 'send',
    channel: 'msg',
    clientMsgId,
    createdAt: new Date().toISOString(),
    ciphertext,
    ...extra,
  });

  it('по HTTP сообщение не принимается вовсе — автора из тела запроса больше нет', async () => {
    // Проба P7: любой участник слал по HTTP сообщение «от мамы».
    const res = await r.call('send', {
      method: 'POST',
      token: TOKEN,
      body: { channel: 'msg', clientMsgId: 'forged-http', senderMemberId: OWNER, ciphertext: 'подделка' },
    });
    expect(res.status).toBe(403);
    // Даже владельцу: по HTTP идут только конверты с ключом.
    const own = await r.call('send', {
      method: 'POST',
      token: TOKEN,
      headers: { 'X-Family-Owner': OWNER_SECRET },
      body: { channel: 'msg', clientMsgId: 'owner-http', ciphertext: 'x' },
    });
    expect(own.status).toBe(403);
    expect((await history(r)).map((i) => i.itemId)).toEqual([]);
  });

  it('по сокету автор — участник соединения, а не названный в кадре', async () => {
    const ws = r.addSocket(ALICE);
    await frame(r, ws, msg('forged-ws', 'текст', { senderMemberId: OWNER }));
    expect((await history(r)).find((i) => i.itemId === 'forged-ws')?.senderMemberId).toBe(ALICE);
  });

  it('чужое сообщение не переписать: исходный текст остаётся у всех', async () => {
    // Проба P12 / F3: «Забери Аню в 17:00» тихо превращалось в «Аню не
    // забирай» без пометки «изменено», а исходный текст пропадал у всех.
    const owner = r.addSocket(OWNER);
    await frame(r, owner, msg('m1', 'Забери Аню в 17:00'));
    const alice = r.addSocket(ALICE);
    await frame(r, alice, msg('m1', 'Аню не забирай, я сама', { edit: true, senderMemberId: OWNER }));
    expect(framesOf(alice).find((f) => f.type === 'nack'), 'правка принята').toMatchObject({ clientMsgId: 'm1', error: 'forbidden' });
    expect(framesOf(alice).some((f) => f.type === 'ack'), 'отказ выглядит как доставка').toBe(false);
    const row = (await history(r)).find((i) => i.itemId === 'm1');
    expect(row).toMatchObject({ senderMemberId: OWNER, ciphertext: 'Забери Аню в 17:00' });
  });

  it('своё сообщение правится как раньше', async () => {
    const owner = r.addSocket(OWNER);
    await frame(r, owner, msg('m2', 'черновик'));
    await frame(r, owner, msg('m2', 'исправлено', { edit: true }));
    const rows = (await history(r)).filter((i) => i.itemId === 'm2');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ senderMemberId: OWNER, ciphertext: 'исправлено' });
  });

  it('чужой профиль не подменить — ни имя, ни цвет, ни публичный ключ', async () => {
    // S1/F10: профиль Алисы с ключом злоумышленника — и после его исключения
    // владелец печатал «конверт Алисы» на этот ключ.
    const http = await r.call('send', {
      method: 'POST',
      token: TOKEN,
      body: { channel: 'member', itemId: ALICE, senderMemberId: ALICE, ciphertext: 'подменённый профиль' },
    });
    expect(http.status).toBe(403);
    const ws = r.addSocket(KICKED);
    await frame(r, ws, { type: 'send', channel: 'member', itemId: ALICE, ciphertext: 'подменённый профиль' });
    expect(framesOf(ws).find((f) => f.type === 'nack')).toMatchObject({ itemId: ALICE, error: 'forbidden' });
    expect((await history(r)).filter((i) => i.channel === 'member')).toEqual([]);
  });

  it('свой профиль пишет сам участник, чужой — только владелец (пометка «исключён»)', async () => {
    await frame(r, r.addSocket(ALICE), { type: 'send', channel: 'member', itemId: ALICE, ciphertext: 'профиль Алисы' });
    await frame(r, r.addSocket(OWNER), { type: 'send', channel: 'member', itemId: KICKED, ciphertext: 'removedAt' });
    const members = (await history(r)).filter((i) => i.channel === 'member');
    expect(members.map((i) => [i.itemId, i.senderMemberId])).toEqual([
      [ALICE, ALICE],
      [KICKED, OWNER],
    ]);
  });

  it('общие задачи правит любой участник', async () => {
    await frame(r, r.addSocket(OWNER), { type: 'send', channel: 'task', itemId: 't1', ciphertext: 'v1' });
    await frame(r, r.addSocket(ALICE), { type: 'send', channel: 'task', itemId: 't1', ciphertext: 'v2' });
    expect((await history(r)).filter((i) => i.channel === 'task').map((i) => [i.ciphertext, i.senderMemberId])).toEqual([['v2', ALICE]]);
  });

  it('соединение без подтверждённой личности не делает ничего и закрывается', async () => {
    // Проба P8: тикет без ответа на задачу + hello от имени жертвы — и
    // сообщения, прочтения, «печатает» и сигналы звонка шли от её имени.
    const other = r.addSocket(OWNER);
    for (const f of [
      { type: 'hello', memberId: ALICE, lastSeq: 0 },
      msg('legacy-1', 'от имени Алисы', { senderMemberId: ALICE }),
      { type: 'rename', name: 'Переименовал чужак' },
      { type: 'seen', seq: 999999 },
      { type: 'typing' },
      { type: 'signal', to: OWNER, call: 'c1', kind: 'offer', data: 'x' },
    ]) {
      const legacy = r.addSocket(null);
      legacy.serializeAttachment({ memberId: ALICE, bound: false });
      await frame(r, legacy, f);
      expect(legacy.closed, `кадр ${f.type} принят`).toEqual({ code: 4401, reason: 'unverified' });
      expect(legacy.sent, `ответ на ${f.type}`).toEqual([]);
    }
    expect(await history(r)).toEqual([]);
    expect(other.sent, 'остальным что-то ушло').toEqual([]);
  });

  it('hello — один раз: повтор не переназывает соединение и не шлёт историю заново', async () => {
    const ws = r.addSocket(ALICE);
    await frame(r, ws, { type: 'hello', lastSeq: 0 });
    await frame(r, ws, { type: 'hello', memberId: OWNER, lastSeq: 0 });
    expect(ws.memberId).toBe(ALICE);
    expect(framesOf(ws).filter((f) => f.type === 'ready')).toHaveLength(1);
  });
});

describe('подтверждение личности при подключении', () => {
  it('с верным ответом тикет привязан к участнику', async () => {
    const r = await setup();
    const proof = await answer(r, ALICE, r.keys[ALICE].priv);
    const res = await r.call('ticket', { method: 'POST', token: TOKEN, body: proof });
    expect(await res.json()).toMatchObject({ bound: true });
  });

  it('участник, назвавшийся чужим именем, остаётся собой', async () => {
    const r = await setup();
    // Соединение поднято по привязанному тикету — как это делает воркер.
    const ws = r.addSocket(ALICE);
    // ...и в hello он называется владельцем группы.
    await frame(r, ws, { type: 'hello', memberId: OWNER, lastSeq: 0 });
    // Сервер не послушал: соединение осталось тем, чью личность подтвердила задача.
    expect(ws.memberId, 'подмена личности прошла').toBe(ALICE);
  });

  it('без ответа на задачу тикета нет', async () => {
    // Раньше такой выдавался «обычным», и в hello участник называл себя сам
    // — то есть кем угодно (проба P8). 409, а не 401 и не 403: на 401
    // приложение пошло бы за конвертом, на 403 решило бы, что его исключили.
    const r = await setup();
    const res = await r.call('ticket', { method: 'POST', token: TOKEN });
    expect(res.status).toBe(409);
  });

  it('неверный ответ на задачу тикета не даёт', async () => {
    const r = await setup();
    const proof = await answer(r, ALICE, r.keys[ALICE].priv);
    const res = await r.call('ticket', { method: 'POST', token: TOKEN, body: { ...proof, nonce: 'наугад' } });
    expect(res.status).toBe(409);
    // И задача погашена: второй попытки с тем же challengeId нет.
    const again = await r.call('ticket', { method: 'POST', token: TOKEN, body: proof });
    expect(again.status).toBe(409);
  });

  it('тикет без подтверждения сокет не открывает', async () => {
    // Такие выдавала прежняя версия — в последние полминуты до выката.
    const r = await setup();
    const sql = (r.room as unknown as { sql: { exec: (q: string, ...p: unknown[]) => unknown } }).sql;
    sql.exec('INSERT INTO meta (k, v) VALUES (?, ?)', 'ticket:old', JSON.stringify({ exp: Date.now() + 30_000, memberId: null }));
    expect((await r.call('ws?ticket=old')).status).toBe(401);
  });
});

// Аудит 18.11, S6/F9: подписка одна на участника, и любой из группы подменял
// или снимал чужую — человек переставал узнавать о сообщениях и звонках.
describe('уведомления — по подтверждённой личности', () => {
  const subOf = (r: Room, id: string) =>
    (r.room as unknown as { sql: { exec: (q: string, ...p: unknown[]) => { toArray: () => { push_sub: string | null }[] } } }).sql
      .exec('SELECT push_sub FROM members WHERE member_id=?', id)
      .toArray()[0]?.push_sub ?? null;

  it('чужую подписку не подменить и не снять, назвав чужое имя', async () => {
    const r = await setup();
    const own = await answer(r, ALICE, r.keys[ALICE].priv);
    expect((await r.call('push-sub', { method: 'POST', token: TOKEN, body: { subscription: { endpoint: 'alice' }, ...own } })).status).toBe(200);

    // Проба P10: злоумышленник называет Алису в теле запроса.
    const sub = await r.call('push-sub', { method: 'POST', token: TOKEN, body: { memberId: ALICE, subscription: { endpoint: 'evil' } } });
    expect(sub.status).toBe(409);
    const unsub = await r.call('push-unsub', { method: 'POST', token: TOKEN, body: { memberId: ALICE } });
    expect(unsub.status).toBe(409);
    // С ответом на СВОЮ задачу он меняет только свою подписку.
    const mine = await answer(r, KICKED, r.keys[KICKED].priv);
    await r.call('push-unsub', { method: 'POST', token: TOKEN, body: { memberId: ALICE, ...mine } });

    expect(JSON.parse(subOf(r, ALICE)!)).toEqual({ endpoint: 'alice' });
  });

  it('свою подписку участник ставит и снимает ответом на задачу', async () => {
    const r = await setup();
    await r.call('push-sub', { method: 'POST', token: TOKEN, body: { subscription: { endpoint: 'a' }, ...(await answer(r, ALICE, r.keys[ALICE].priv)) } });
    expect(subOf(r, ALICE)).toBeTruthy();
    const res = await r.call('push-unsub', { method: 'POST', token: TOKEN, body: await answer(r, ALICE, r.keys[ALICE].priv) });
    expect(await res.json()).toEqual({ ok: true, cleared: true });
    expect(subOf(r, ALICE)).toBeNull();
  });

  it('назвавшись чужим именем, не сделать того «в сети» — пуши ему уходят', async () => {
    // Второй путь тишины: «в сети» пуши не шлются.
    const r = await setup();
    const legacy = r.addSocket(null);
    legacy.serializeAttachment({ memberId: ALICE, bound: false });
    r.addSocket(OWNER);
    const online = (r.room as unknown as { onlineMemberIds: () => string[] }).onlineMemberIds();
    expect(online).toEqual([OWNER]);
  });
});

describe('звонок адресату с замороженным приложением', () => {
  // iOS замораживает приложение в фоне, а его сокет на сервере живёт ещё
  // долго. Раньше приглашение в такой сокет считалось доставленным — и пуш
  // «Входящий звонок» не уходил: телефон молчал, звонок проходил мимо.
  it('приглашение в молчащий сокет не считается доставленным — уходит пуш', async () => {
    const { room, addSocket } = makeRoom();
    const caller = addSocket('mom');
    caller.serializeAttachment({ memberId: 'mom', bound: true, at: Date.now() });
    const callee = addSocket('vlad');
    callee.serializeAttachment({ memberId: 'vlad', bound: true, at: Date.now() - 60_000 }); // последний пинг — минуту назад
    const offer = (call: string) =>
      room.webSocketMessage(caller, JSON.stringify({ type: 'signal', to: 'vlad', call, kind: 'offer', data: 'x' }));
    const pending = () =>
      (room.sql.exec("SELECT k FROM meta WHERE k LIKE 'callpend:%'").toArray() as { k: string }[]).map((r) => r.k);

    await offer('c1');
    expect(callee.sent.some((f) => f.includes('"kind":"offer"')), 'кадр всё равно отдан — вдруг жив').toBe(true);
    expect(pending(), 'дозвон без пуша').toEqual(['callpend:c1']);

    // Живое приложение само покажет входящий — пуш ему не нужен.
    callee.serializeAttachment({ memberId: 'vlad', bound: true, at: Date.now() });
    await offer('c2');
    expect(pending()).toEqual(['callpend:c1']);
  });

  it('трубку сняли на телефоне — второе устройство того же участника перестаёт звонить', async () => {
    const { room, addSocket } = makeRoom();
    const caller = addSocket('mom');
    const phone = addSocket('vlad');
    const mac = addSocket('vlad');
    await room.webSocketMessage(phone, JSON.stringify({ type: 'signal', to: 'mom', call: 'c1', kind: 'accepted', data: null }));
    const stop = mac.sent.map((f) => JSON.parse(f)).find((f) => f.kind === 'cancel');
    expect(stop, 'второе устройство звонит дальше').toMatchObject({ from: 'mom', to: 'vlad', call: 'c1' });
    expect(phone.sent.some((f) => f.includes('"cancel"')), 'отбой ответившему').toBe(false);
    expect(caller.sent.some((f) => f.includes('"accepted"'))).toBe(true);
  });
});
