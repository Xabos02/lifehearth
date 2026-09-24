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
    const s: FakeSocket = { memberId, att: memberId ? { memberId } : null, closed: null, sent: [] };
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

async function setup() {
  const r = makeRoom();
  // Первый запрос закрепляет токен группы (TOFU).
  await r.call('register', {
    method: 'POST',
    token: TOKEN,
    body: { memberId: OWNER, boxPub: 'pub-owner', ownerSecretHash: await sha256hex(OWNER_SECRET) },
  });
  for (const id of [ALICE, KICKED]) {
    await r.call('register', { method: 'POST', token: TOKEN, body: { memberId: id, boxPub: `pub-${id}` } });
  }
  return r;
}

async function remove(r: Awaited<ReturnType<typeof setup>>, memberId: string, newToken: string, secret = OWNER_SECRET) {
  return r.call('remove', {
    method: 'POST',
    token: TOKEN,
    headers: { 'X-Family-Owner': secret },
    body: { memberId, newTokenHash: await sha256hex(newToken) },
  });
}

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
    expect((await r.call('ticket', { method: 'POST', token: TOKEN })).status).toBe(401);
    expect((await r.call('ticket', { method: 'POST', token: 'token-group-2' })).status).toBe(200);
  });

  it('живое соединение исключённого рвётся сразу', async () => {
    const sock = r.addSocket(KICKED);
    const other = r.addSocket(ALICE);
    await remove(r, KICKED, 'token-group-2');
    expect(sock.closed).toEqual({ code: 4403, reason: 'removed' });
    expect(other.closed).toBeNull();
    expect(other.sent.some((f) => JSON.parse(f).type === 'removed')).toBe(true);
  });

  it('исключённому не выдают тикет даже с верным токеном', async () => {
    // Он мог узнать новый токен другим путём — например, с ещё не отключённого
    // второго своего устройства. Пометка removed_at важнее токена.
    await remove(r, KICKED, 'token-group-2');
    const res = await r.call(`ticket?memberId=${KICKED}`, { method: 'POST', token: 'token-group-2' });
    expect(res.status).toBe(403);
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
    await r.call('push-sub', { method: 'POST', token: TOKEN, body: { memberId: KICKED, subscription: { endpoint: 'e' } } });
    await remove(r, KICKED, 'token-group-2');
    const res = await r.call('push-sub', { method: 'POST', token: 'token-group-2', body: { memberId: KICKED, subscription: { endpoint: 'e' } } });
    expect(res.status).toBe(403);
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
    expect((await r.call('ticket', { method: 'POST', token: TOKEN })).status).toBe(200);
  });

  it('живые соединения рвутся кодом «удалена», а не «исключён»', async () => {
    const a = r.addSocket(ALICE);
    const b = r.addSocket(KICKED);
    expect((await deleteGroup(r)).status).toBe(200);
    expect(a.closed).toEqual({ code: 4404, reason: 'deleted' });
    expect(b.closed).toEqual({ code: 4404, reason: 'deleted' });
  });

  it('после удаления комната отвечает 410 — клиент отличает это от исключения', async () => {
    await r.call('send', { method: 'POST', token: TOKEN, body: { channel: 'msg', clientMsgId: 'm1', ciphertext: 'x' } });
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
    const { ticket } = (await (await r.call('ticket', { method: 'POST', token: TOKEN })).json()) as { ticket: string };
    await deleteGroup(r);
    expect((await r.call(`ws?ticket=${ticket}`)).status).toBe(410);
  });

  it('конверты с ключами стираются вместе с группой', async () => {
    await r.call('send', { method: 'POST', token: TOKEN, body: { channel: 'key', itemId: ALICE, ciphertext: 'конверт-для-alice' } });
    expect(await (await r.call(`keys?member=${ALICE}`)).json()).toEqual({ sealed: 'конверт-для-alice' });
    await deleteGroup(r);
    expect(await (await r.call(`keys?member=${ALICE}`)).json()).toEqual({ sealed: null });
  });
});

describe('конверты с новым ключом', () => {
  it('отдаются без авторизации — иначе офлайн-участник заперт снаружи', async () => {
    // Он приходит со старым токеном: новый лежит как раз в конверте.
    const r = await setup();
    await r.call('send', {
      method: 'POST',
      token: TOKEN,
      body: { channel: 'key', itemId: ALICE, ciphertext: 'конверт-для-alice' },
    });
    await remove(r, KICKED, 'token-group-2');
    const res = await r.call(`keys?member=${ALICE}`);
    expect(await res.json()).toEqual({ sealed: 'конверт-для-alice' });
  });

  it('конверт исключённого исчезает при исключении', async () => {
    const r = await setup();
    await r.call('send', {
      method: 'POST',
      token: TOKEN,
      body: { channel: 'key', itemId: KICKED, ciphertext: 'конверт-для-исключённого' },
    });
    await remove(r, KICKED, 'token-group-2');
    expect(await (await r.call(`keys?member=${KICKED}`)).json()).toEqual({ sealed: null });
  });

  it('чужого конверта не существует', async () => {
    const r = await setup();
    expect(await (await r.call('keys?member=посторонний')).json()).toEqual({ sealed: null });
  });

  it('повторная рассылка заменяет прежний конверт, а не копит', async () => {
    const r = await setup();
    for (const ct of ['эпоха-1', 'эпоха-2']) {
      await r.call('send', { method: 'POST', token: TOKEN, body: { channel: 'key', itemId: ALICE, ciphertext: ct } });
    }
    expect(await (await r.call(`keys?member=${ALICE}`)).json()).toEqual({ sealed: 'эпоха-2' });
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
    expect(rows[0].box_pub).toBe(`pub-${ALICE}`);
  });
});

describe('авторство сообщения', () => {
  it('ставится по сессии соединения, а не по тому, что прислал отправитель', async () => {
    const r = await setup();
    const ws = r.addSocket(null);
    // Соединение представилось Алисой — дальше сервер знает, кто на том конце.
    await r.room.webSocketMessage(ws, JSON.stringify({ type: 'hello', memberId: ALICE, lastSeq: 0 }));
    // ...и Алиса присылает кадр, подписанный владельцем группы. Токен группы
    // есть у каждого участника, поэтому такой кадр отправить может любой:
    // без проверки переписка семьи принимала бы сообщения «от мамы» от кого
    // угодно из группы.
    await r.room.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'send',
        channel: 'msg',
        clientMsgId: 'forged-1',
        senderMemberId: OWNER,
        createdAt: new Date().toISOString(),
        ciphertext: 'зашифрованный текст',
      }),
    );

    const res = await r.call('messages?since=0', { token: TOKEN });
    const page = (await res.json()) as { items: { itemId: string; senderMemberId: string | null }[] };
    const item = page.items.find((i) => i.itemId === 'forged-1');
    expect(item, 'сообщение не записалось вовсе').toBeTruthy();
    expect(item!.senderMemberId, 'сервер принял чужое авторство').toBe(ALICE);
  });

  it('кадр без представившейся сессии сохраняет заявленного автора', async () => {
    // Путь до hello: attachment пуст, ломать авторство честному клиенту нельзя.
    const r = await setup();
    const ws = r.addSocket(null);
    await r.room.webSocketMessage(
      ws,
      JSON.stringify({
        type: 'send',
        channel: 'msg',
        clientMsgId: 'early-1',
        senderMemberId: ALICE,
        createdAt: new Date().toISOString(),
        ciphertext: 'шифр',
      }),
    );
    const res = await r.call('messages?since=0', { token: TOKEN });
    const page = (await res.json()) as { items: { itemId: string; senderMemberId: string | null }[] };
    expect(page.items.find((i) => i.itemId === 'early-1')?.senderMemberId).toBe(ALICE);
  });
});

describe('подтверждение личности при подключении', () => {
  // Полный цикл настоящей криптографией: участник регистрирует публичный ключ,
  // сервер запечатывает им случайное слово, участник открывает его своим
  // приватным — и только тогда тикет привязывается к нему.
  async function joinWithKeys(r: Awaited<ReturnType<typeof setup>>, memberId: string) {
    const { generateBoxKeyPair, exportBoxPublic, exportBoxPrivate, importBoxPublic, importBoxPrivate, openFrom } =
      await import('../src/lib/crypto');
    const pair = await generateBoxKeyPair();
    const pub = await exportBoxPublic(pair.publicKey);
    const priv = await exportBoxPrivate(pair.privateKey);
    await r.call('register', { method: 'POST', token: TOKEN, body: { memberId, boxPub: pub } });

    const chRes = await r.call('challenge', { method: 'POST', token: TOKEN, body: { memberId } });
    const { challenge } = (await chRes.json()) as {
      challenge: { challengeId: string; ephPub: string; sealed: string } | null;
    };
    if (!challenge) return { ticket: null as string | null, priv };
    const { nonce } = await openFrom<{ nonce: string }>(
      await importBoxPublic(challenge.ephPub),
      await importBoxPrivate(priv),
      challenge.sealed,
    );
    const tRes = await r.call('ticket', {
      method: 'POST',
      token: TOKEN,
      body: { challengeId: challenge.challengeId, nonce },
    });
    const { ticket, bound } = (await tRes.json()) as { ticket: string; bound: boolean };
    expect(bound, 'ответ на задачу не привязал тикет').toBe(true);
    return { ticket, priv };
  }

  it('участник, назвавшийся чужим именем, остаётся собой', async () => {
    const r = await setup();
    // Новый участник, а не ALICE из фикстуры: там публичный ключ уже закреплён
    // строкой-заглушкой, а TOFU не даёт заменить его настоящим — и правильно
    // делает, иначе любой с токеном подменял бы чужой ключ.
    const NEWCOMER = 'newcomer-1';
    const { ticket } = await joinWithKeys(r, NEWCOMER);
    expect(ticket).toBeTruthy();

    // Соединение поднято по привязанному тикету — как это делает воркер.
    const ws = r.addSocket(null);
    ws.serializeAttachment({ memberId: NEWCOMER, bound: true });

    // ...и в hello он называется владельцем группы.
    await r.room.webSocketMessage(ws, JSON.stringify({ type: 'hello', memberId: OWNER, lastSeq: 0 }));

    // Сервер не послушал: соединение осталось тем, чью личность подтвердила задача.
    expect(ws.memberId, 'подмена личности прошла').toBe(NEWCOMER);
  });

  it('без ответа на задачу тикет остаётся обычным — старый клиент не заперт', async () => {
    const r = await setup();
    const res = await r.call('ticket', { method: 'POST', token: TOKEN });
    const { ticket, bound } = (await res.json()) as { ticket: string; bound: boolean };
    expect(ticket).toBeTruthy();
    expect(bound).toBe(false);

    // Такое соединение по-прежнему представляется само — иначе устройства,
    // которые ещё не обновились, потеряли бы доступ к семейному чату.
    const ws = r.addSocket(null);
    await r.room.webSocketMessage(ws, JSON.stringify({ type: 'hello', memberId: ALICE, lastSeq: 0 }));
    expect(ws.memberId).toBe(ALICE);
  });

  it('неверный ответ на задачу не привязывает тикет', async () => {
    const r = await setup();
    await r.call('register', { method: 'POST', token: TOKEN, body: { memberId: ALICE, boxPub: 'pub-alice-raw' } });
    const chRes = await r.call('challenge', { method: 'POST', token: TOKEN, body: { memberId: ALICE } });
    const { challenge } = (await chRes.json()) as { challenge: { challengeId: string } | null };
    // Ключ участника нечитаемый — сервер честно отвечает «задачи нет», вместо
    // того чтобы запереть человека снаружи.
    if (!challenge) {
      const res = await r.call('ticket', { method: 'POST', token: TOKEN, body: { challengeId: 'x', nonce: 'y' } });
      const { bound } = (await res.json()) as { bound: boolean };
      expect(bound).toBe(false);
      return;
    }
    const res = await r.call('ticket', {
      method: 'POST',
      token: TOKEN,
      body: { challengeId: challenge.challengeId, nonce: 'наугад' },
    });
    const { bound } = (await res.json()) as { bound: boolean };
    expect(bound, 'сервер принял неверный ответ').toBe(false);
  });
});
