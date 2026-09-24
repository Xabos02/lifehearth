// FamilyRoom — Durable Object: одна комната на семью. Источник истины для
// семейных данных (чат + задачи + профили). DO видит ТОЛЬКО шифротекст —
// содержимое зашифровано общим семейным ключом на устройствах.
//
// Надёжность: каждая запись получает монотонный seq (AUTOINCREMENT) ДО рассылки.
// WebSocket — лишь ускоритель; при разрыве клиент догружает всё since lastSeq
// (backfill) — ни одно сообщение/задача не теряется. Каналы 'msg'|'member'|'task'
// в одном seq-потоке. Для msg дедуп по client_msg_id (exactly-once в БД).

import { DurableObject } from 'cloudflare:workers';
import { buildPushRequest } from './webpush.js';

const TICKET_TTL_MS = 30_000;
const CALL_PENDING_TTL_MS = 32_000; // 30с ринга + буфер: после этого недобитый дозвон = «пропущенный»
const BACKFILL_PAGE = 500;
const MSG_RETENTION_DAYS = 180;
const MSG_RETENTION_MAX = 5000;
const PRUNE_EVERY = 50; // прунить раз в N вставок сообщений

const IV_BYTES = 12;
const BOX_CURVE = { name: 'ECDH', namedCurve: 'P-256' };
/** Задача на подтверждение личности живёт минуту: этого хватает на медленную
 *  сеть и мало на то, чтобы её где-то перехватить и переиспользовать. */
const CHALLENGE_TTL_MS = 60_000;

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Запечатать данные так, чтобы открыл только владелец boxPub.
 *
 *  Тот же конверт, что участники раскладывают друг другу с ключом группы
 *  (ECDH P-256 → AES-256-GCM, base64url(IV+шифротекст)), — но отправитель
 *  здесь эфемерный: серверу незачем иметь постоянный ключ, ему нужно ровно
 *  один раз спросить «а ты правда тот, кем представляешься». Формат совпадает
 *  с lib/crypto.ts на клиенте, иначе openFrom его не откроет. */
async function sealForMember(boxPubB64, data) {
  const theirPub = await crypto.subtle.importKey('raw', b64urlToBytes(boxPubB64), BOX_CURVE, false, []);
  const eph = await crypto.subtle.generateKey(BOX_CURVE, true, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPub },
    eph.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data))),
  );
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return {
    ephPub: bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey))),
    sealed: bytesToB64url(combined),
  };
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class FamilyRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        item_id TEXT NOT NULL,
        client_msg_id TEXT,
        sender_member_id TEXT,
        created_at TEXT,
        ciphertext TEXT NOT NULL,
        UNIQUE(channel, item_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_items_cmid ON items(client_msg_id) WHERE client_msg_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS members (
        member_id TEXT PRIMARY KEY,
        push_sub TEXT,
        last_seen_seq INTEGER DEFAULT 0,
        joined_at TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    // last_online_at и колонки исключения добавляем отдельными ALTER: у уже
    // существующих DO таблица members создана без них (CREATE TABLE IF NOT
    // EXISTS колонку не добавит).
    for (const col of ['last_online_at TEXT', 'box_pub TEXT', 'removed_at TEXT']) {
      try {
        this.sql.exec(`ALTER TABLE members ADD COLUMN ${col}`);
      } catch {
        /* колонка уже есть */
      }
    }
    this.insertsSincePrune = 0;
  }

  // Кто сейчас онлайн: memberId всех живых WebSocket-соединений.
  onlineMemberIds() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.memberId) ids.add(att.memberId);
    }
    return [...ids];
  }

  broadcastPresence() {
    const frame = JSON.stringify({ type: 'presence', online: this.onlineMemberIds(), lastSeen: this.lastSeenMap() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        /* сокет закрывается */
      }
    }
  }

  // === Авторизация семейным токеном (TOFU, как личный authAccount) ===
  async checkToken(token) {
    if (!token) return false;
    const hash = await sha256hex(token);
    const row = this.sql.exec('SELECT v FROM meta WHERE k=?', 'token_hash').toArray()[0];
    if (!row) {
      this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?)', 'token_hash', hash);
      return true;
    }
    return row.v === hash;
  }

  metaGet(k) {
    return this.sql.exec('SELECT v FROM meta WHERE k=?', k).toArray()[0]?.v ?? null;
  }

  metaSet(k, v) {
    this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, v);
  }

  isRemoved(memberId) {
    if (!memberId) return false;
    const r = this.sql
      .exec('SELECT removed_at FROM members WHERE member_id=?', memberId)
      .toArray()[0];
    return Boolean(r?.removed_at);
  }

  /** Владелец группы — тот, кто её создал. Доказательство владения: секрет,
   *  который есть только у него (в приглашение не попадает). Сервер хранит
   *  хеш; TOFU, как и с токеном — первый заявивший становится владельцем.
   *
   *  Зачем отдельный секрет, а не общий токен: токен есть у всех, включая
   *  того, кого исключают. С ним любой участник мог бы сменить токен группы
   *  на свой и запереть остальных снаружи — не прочитать переписку, но
   *  сломать её всем. */
  async checkOwner(secret) {
    if (!secret) return false;
    const stored = this.metaGet('owner_secret_hash');
    if (!stored) return false;
    return stored === (await sha256hex(secret));
  }

  json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    // Запоминаем familyId этой комнаты один раз — нужен для адресных пуш-тегов,
    // чтобы уведомления разных групп на одном устройстве не схлопывались.
    const fid = url.searchParams.get('familyId');
    if (fid && !this.sql.exec('SELECT v FROM meta WHERE k=?', 'family_id').toArray()[0]) {
      this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'family_id', fid);
    }
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token') || '';

    // WebSocket upgrade — проверяем одноразовый тикет (браузерный WS не шлёт заголовки)
    if (path.endsWith('/ws')) {
      // Удалённая группа не открывает сокет даже по тикету, выданному до
      // удаления: иначе в пустую комнату снова начали бы писать, и стёртая
      // переписка наполнялась бы заново.
      if (this.metaGet('deleted') === '1') return new Response('deleted', { status: 410 });
      const ticket = url.searchParams.get('ticket');
      const pass = ticket ? this.consumeTicket(ticket) : null;
      if (!pass) return new Response('unauthorized', { status: 401 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      // Личность подтверждена задачей — записываем её В СОЕДИНЕНИЕ сразу, до
      // единого кадра от клиента. Дальше hello уже ничего не решает: раньше он
      // просто заявлял memberId, и любой участник группы (токен есть у всех)
      // мог назваться другим — а по этому имени доставляются адресные сигналы
      // звонка и отмечается прочтение.
      if (pass.memberId) pair[1].serializeAttachment({ memberId: pass.memberId, bound: true });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Конверты с новым ключом группы — БЕЗ авторизации, и это намеренно.
    // После исключения участника токен группы меняется, и тот, кто был офлайн,
    // приходит со старым: авторизоваться ему нечем, а новый токен лежит как раз
    // в его конверте. Без этой двери он остался бы заперт снаружи вместе с
    // исключённым. Отдавать конверты безопасно: каждый зашифрован личным ключом
    // адресата, и посторонний не откроет ни одного. Знать при этом надо и
    // familyId, и memberId — оба случайные uuid.
    if (path.endsWith('/keys') && request.method === 'GET') {
      const member = url.searchParams.get('member') || '';
      const row = this.sql
        .exec('SELECT ciphertext FROM items WHERE channel=? AND item_id=?', 'key', member)
        .toArray()[0];
      if (!row || this.isRemoved(member)) return this.json({ sealed: null });
      return this.json({ sealed: row.ciphertext });
    }

    // Исключённого отсекаем ДО проверки токена — иначе он получал бы 401,
    // неотличимый от «токен устарел, забери новый конверт», и его приложение
    // молча переподключалось бы вечно, так и не сказав человеку, что случилось.
    // Отдельный код 403 — единственный способ показать ему внятное сообщение.
    // Утечки здесь нет: чтобы спросить, надо знать и familyId, и memberId.
    if (this.isRemoved(url.searchParams.get('memberId'))) {
      return this.json({ error: 'removed' }, 403);
    }

    // Группа удалена владельцем: старый токен больше не действует, а по нему
    // пересоздать пустую группу нельзя. 410 — отличимый от 403 («вас
    // исключили»), чтобы клиент показал честное «группа удалена».
    if (this.metaGet('deleted') === '1') {
      return this.json({ error: 'deleted' }, 410);
    }

    // Остальное — Bearer-токен
    if (!(await this.checkToken(token))) return this.json({ error: 'unauthorized' }, 401);

    // Задача на подтверждение личности: сервер запечатывает случайное слово
    // ключом участника. Открыть его может только тот, у кого есть парный
    // приватный ключ, — то есть сам участник. Человек об этом не знает и
    // ничего не делает: всё происходит внутри подключения.
    if (path.endsWith('/challenge') && request.method === 'POST') {
      const { memberId } = await request.json();
      if (!memberId) return this.json({ error: 'bad request' }, 400);
      const row = this.sql.exec('SELECT box_pub FROM members WHERE member_id=?', memberId).toArray()[0];
      // Ключа нет — участник ещё не регистрировался (первый заход) или пришёл
      // со сборки, которая ключей не заводила. Спрашивать нечего: пусть берёт
      // обычный тикет, как раньше. Это осознанный компромисс на время, пока
      // обновятся все устройства семьи, а не дыра «навсегда».
      if (!row?.box_pub) return this.json({ challenge: null });
      const nonce = crypto.randomUUID();
      const challengeId = crypto.randomUUID();
      this.sql.exec(
        'INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)',
        `chal:${challengeId}`,
        JSON.stringify({ memberId, nonce, exp: Date.now() + CHALLENGE_TTL_MS }),
      );
      try {
        const { ephPub, sealed } = await sealForMember(row.box_pub, { nonce });
        return this.json({ challenge: { challengeId, ephPub, sealed } });
      } catch {
        // Ключ участника не читается (битая запись, чужой формат) — не запираем
        // человека снаружи из-за нашей же криптографии.
        this.sql.exec('DELETE FROM meta WHERE k=?', `chal:${challengeId}`);
        return this.json({ challenge: null });
      }
    }

    if (path.endsWith('/ticket') && request.method === 'POST') {
      // Тикет с ответом на задачу ПРИВЯЗЫВАЕТСЯ к участнику: дальше сервер
      // знает, кто на том конце сокета, и заявленный в hello memberId уже
      // ничего не решает. Без ответа тикет остаётся обычным — так же, как до
      // этой правки.
      let bound = null;
      const body = await request.json().catch(() => null);
      if (body?.challengeId && body?.nonce) {
        const key = `chal:${body.challengeId}`;
        const raw = this.sql.exec('SELECT v FROM meta WHERE k=?', key).toArray()[0];
        this.sql.exec('DELETE FROM meta WHERE k=?', key); // одноразовая
        if (raw) {
          const chal = JSON.parse(raw.v);
          if (chal.exp > Date.now() && chal.nonce === body.nonce) bound = chal.memberId;
        }
      }
      const ticket = crypto.randomUUID();
      this.sql.exec(
        'INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)',
        `ticket:${ticket}`,
        JSON.stringify({ exp: Date.now() + TICKET_TTL_MS, memberId: bound }),
      );
      return this.json({ ticket, bound: bound != null });
    }

    // Регистрация участника: публичный ключ для адресных конвертов. TOFU —
    // первый заявленный ключ закрепляется за memberId навсегда, иначе любой с
    // токеном подменил бы чужой ключ и получил бы адресованный тому конверт.
    if (path.endsWith('/register') && request.method === 'POST') {
      const { memberId, boxPub, ownerSecretHash } = await request.json();
      if (!memberId || !boxPub) return this.json({ error: 'bad request' }, 400);
      if (this.isRemoved(memberId)) return this.json({ error: 'removed' }, 403);
      this.sql.exec(
        'INSERT INTO members (member_id, box_pub, joined_at) VALUES (?,?,?) ON CONFLICT(member_id) DO UPDATE SET box_pub = COALESCE(members.box_pub, excluded.box_pub)',
        memberId,
        boxPub,
        new Date().toISOString(),
      );
      // Владелец закрепляется один раз — за тем, кто создал группу. Приглашённые
      // секрета не знают и заявку не пришлют.
      let owner = this.metaGet('owner_member_id');
      if (!owner && ownerSecretHash) {
        this.metaSet('owner_member_id', memberId);
        this.metaSet('owner_secret_hash', ownerSecretHash);
        owner = memberId;
      }
      return this.json({ ok: true, owner, isOwner: owner === memberId });
    }

    // Исключить участника. Пускает только владелец — по своему секрету.
    // Здесь же меняется токен группы: без этого исключённый вошёл бы заново
    // под новым memberId, ведь токен у него на руках.
    if (path.endsWith('/remove') && request.method === 'POST') {
      const { memberId, newTokenHash } = await request.json();
      if (!(await this.checkOwner(request.headers.get('X-Family-Owner')))) {
        return this.json({ error: 'forbidden' }, 403);
      }
      if (!memberId || !newTokenHash) return this.json({ error: 'bad request' }, 400);
      if (memberId === this.metaGet('owner_member_id')) {
        return this.json({ error: 'owner cannot be removed' }, 400);
      }
      this.sql.exec(
        "UPDATE members SET removed_at = ?, push_sub = NULL WHERE member_id = ?",
        new Date().toISOString(),
        memberId,
      );
      // Конверт исключённого выкидываем: иначе он бы забрал из него новый ключ.
      this.sql.exec('DELETE FROM items WHERE channel=? AND item_id=?', 'key', memberId);
      this.metaSet('token_hash', newTokenHash);
      // Живое соединение рвём сразу — иначе он читал бы чат до следующего
      // разрыва сети, а нового ключа у него уже нет.
      for (const ws of this.ctx.getWebSockets()) {
        if (ws.deserializeAttachment()?.memberId === memberId) {
          try {
            ws.close(4403, 'removed');
          } catch {
            /* уже закрыт */
          }
        }
      }
      this.broadcastFrame({ type: 'removed', memberId });
      return this.json({ ok: true });
    }

    // Удалить группу целиком. Пускает только владелец — по своему секрету.
    // Группа исчезает для всех: живым соединениям рвём сокет кодом 4404
    // («удалена», отличимым от 4403 «исключён»), офлайн-участникам оставляем
    // надгробие, чтобы вернувшийся со старым токеном не пересоздал пустую
    // группу (checkToken на пустой комнате сработал бы как TOFU).
    if (path.endsWith('/delete') && request.method === 'POST') {
      if (!(await this.checkOwner(request.headers.get('X-Family-Owner')))) {
        return this.json({ error: 'forbidden' }, 403);
      }
      // Надгробие ДО стирания таблиц: порядок важен, иначе в окне между
      // wipe и metaSet чужой /ticket заново зарегистрировал бы токен.
      this.metaSet('deleted', '1');
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(4404, 'deleted');
        } catch {
          /* уже закрыт */
        }
      }
      this.sql.exec('DELETE FROM items');
      this.sql.exec('DELETE FROM members');
      // Невыкупленные тикеты и незавершённые дозвоны — тоже: будильник по
      // дозвону иначе отправил бы «пропущенный звонок» уже из удалённой группы.
      this.sql.exec("DELETE FROM meta WHERE k LIKE 'ticket:%' OR k LIKE 'callpend:%'");
      return this.json({ ok: true });
    }

    if (path.endsWith('/messages') && request.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const page = this.backfill(since);
      return this.json(page);
    }

    if (path.endsWith('/send') && request.method === 'POST') {
      const body = await request.json();
      const res = await this.ingest(body);
      return this.json(res);
    }

    // ICE-серверы для звонков: STUN всегда бесплатен; TURN-креды генерим из
    // Cloudflare Realtime, если заданы секреты (иначе остаёмся на STUN).
    if (path.endsWith('/turn') && request.method === 'GET') {
      return this.json({ iceServers: await this.iceServers() });
    }

    if (path.endsWith('/push-sub') && request.method === 'POST') {
      const { memberId, subscription } = await request.json();
      if (this.isRemoved(memberId)) return this.json({ error: 'removed' }, 403);
      if (memberId) {
        this.sql.exec(
          'INSERT INTO members (member_id, push_sub, joined_at) VALUES (?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET push_sub=excluded.push_sub',
          memberId,
          JSON.stringify(subscription),
          new Date().toISOString(),
        );
      }
      return this.json({ ok: true });
    }

    // Отписка от уведомлений группы при выходе из неё. Без этой двери
    // телефон вышедшего продолжал звенеть «Входящий звонок» и «Новое
    // сообщение»: сервер по-прежнему считал его офлайн-участником и слал
    // пуши. Локальная чистка данных на устройстве этот канал не закрывала.
    if (path.endsWith('/push-unsub') && request.method === 'POST') {
      const { memberId } = await request.json();
      let cleared = false;
      if (memberId) {
        const had = this.sql
          .exec('SELECT push_sub FROM members WHERE member_id=?', memberId)
          .toArray()[0];
        cleared = Boolean(had?.push_sub);
        this.sql.exec('UPDATE members SET push_sub=NULL WHERE member_id=?', memberId);
      }
      // cleared говорит вызывающему, была ли подписка снята на самом деле —
      // без этого «200 OK» неотличим от «ничего не сделал».
      return this.json({ ok: true, cleared });
    }

    return this.json({ error: 'not found' }, 404);
  }

  /** Проверить и погасить тикет. Возвращает null, если тикет негоден, иначе
   *  `{ memberId }` — участник, чью личность подтвердила задача (или null,
   *  если тикет обычный, без подтверждения).
   *
   *  Значение раньше было просто временем жизни числом; сборки, чьи тикеты
   *  выданы до этой правки, читаются тем же кодом — иначе при выкате у всех,
   *  кто держал тикет в руках, соединение оборвалось бы на ровном месте. */
  consumeTicket(ticket) {
    const key = `ticket:${ticket}`;
    const row = this.sql.exec('SELECT v FROM meta WHERE k=?', key).toArray()[0];
    if (!row) return null;
    this.sql.exec('DELETE FROM meta WHERE k=?', key); // одноразовый
    let exp = Number(row.v);
    let memberId = null;
    if (Number.isNaN(exp)) {
      try {
        const parsed = JSON.parse(row.v);
        exp = Number(parsed.exp);
        memberId = parsed.memberId ?? null;
      } catch {
        return null;
      }
    }
    return exp > Date.now() ? { memberId } : null;
  }

  // === Запись (идемпотентная по client_msg_id для msg; новый seq для версии task/member) ===
  async ingest({ channel, itemId, clientMsgId, senderMemberId, createdAt, ciphertext, edit, silent, notify }) {
    if (!channel || !ciphertext || (channel === 'msg' && !clientMsgId) || (channel !== 'msg' && !itemId)) {
      return { error: 'bad request' };
    }
    const id = channel === 'msg' ? clientMsgId : itemId;
    const created = createdAt || new Date().toISOString();

    // Дедуп ретрая ОТПРАВКИ (не редактирования): тот же client_msg_id и !edit →
    // вернуть исходный seq. edit=true пропускает дедуп → правка/удаление получают
    // новый seq (новая версия побеждает по seq на клиентах).
    if (channel === 'msg' && !edit) {
      const dup = this.sql.exec('SELECT seq FROM items WHERE client_msg_id=?', clientMsgId).toArray()[0];
      if (dup) return { seq: dup.seq, channel, itemId: id, clientMsgId, duplicate: true };
    }
    // Новая ли это задача (для пуша «новая задача») — проверяем ДО удаления
    // прежней версии: остальные правки задачи молчат, кроме отмеченного клиентом
    // notify (см. ниже).
    const isNewTask =
      channel === 'task' && !this.sql.exec('SELECT 1 FROM items WHERE channel=? AND item_id=? LIMIT 1', channel, id).toArray()[0];

    // task/member мутируемы: новая версия = новый seq, старая строка по item_id заменяется.
    this.sql.exec('DELETE FROM items WHERE channel=? AND item_id=?', channel, id);
    this.sql.exec(
      'INSERT INTO items (channel, item_id, client_msg_id, sender_member_id, created_at, ciphertext) VALUES (?,?,?,?,?,?)',
      channel,
      id,
      channel === 'msg' ? clientMsgId : null,
      senderMemberId || null,
      created,
      ciphertext,
    );
    const seq = this.sql.exec('SELECT last_insert_rowid() AS s').toArray()[0].s;
    const item = { seq, channel, itemId: id, clientMsgId: clientMsgId || null, senderMemberId: senderMemberId || null, createdAt: created, ciphertext };

    this.broadcast(item);
    if (channel === 'msg') {
      // silent — служебные сообщения (журнал звонков и т.п.): в ленту пишем,
      // пушом «Новое сообщение» не дублируем (у звонка свои пуши).
      if (!silent) this.ctx.waitUntil(this.pushOffline(item, senderMemberId, 'msg'));
      if (++this.insertsSincePrune >= PRUNE_EVERY) {
        this.insertsSincePrune = 0;
        this.prune();
      }
    } else if (isNewTask) {
      this.ctx.waitUntil(this.pushOffline(item, senderMemberId, 'task'));
    } else if (channel === 'task' && notify === 'done') {
      // Содержимое задачи шифруется end-to-end, поэтому «выполнена» сервер сам
      // распознать не может — клиент помечает это событие открытым флагом.
      // Флаг несёт только тип события: ни названия, ни имени в него не попадает.
      this.ctx.waitUntil(this.pushOffline(item, senderMemberId, 'task-done'));
    }
    return { seq, channel, itemId: id, clientMsgId: clientMsgId || null };
  }

  backfill(since) {
    const rows = this.sql
      .exec(
        'SELECT seq, channel, item_id, client_msg_id, sender_member_id, created_at, ciphertext FROM items WHERE seq > ? ORDER BY seq LIMIT ?',
        since,
        BACKFILL_PAGE + 1,
      )
      .toArray();
    const hasMore = rows.length > BACKFILL_PAGE;
    const page = (hasMore ? rows.slice(0, BACKFILL_PAGE) : rows).map((r) => ({
      seq: r.seq,
      channel: r.channel,
      itemId: r.item_id,
      clientMsgId: r.client_msg_id,
      senderMemberId: r.sender_member_id,
      createdAt: r.created_at,
      ciphertext: r.ciphertext,
    }));
    const nextSince = page.length ? page[page.length - 1].seq : since;
    return { items: page, hasMore, nextSince };
  }

  headSeq() {
    const row = this.sql.exec('SELECT MAX(seq) AS m FROM items').toArray()[0];
    return row?.m || 0;
  }

  broadcast(item) {
    const frame = JSON.stringify({ type: 'item', ...item });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        /* сокет закрывается */
      }
    }
  }

  // === WebSocket (Hibernation API) ===
  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.close(1003, 'bad frame');
      return;
    }
    if (msg.t === 'ping') {
      ws.send('{"t":"pong"}'); // heartbeat — держит соединение живым
      return;
    }
    if (msg.type === 'hello') {
      // Кто на том конце: подтверждённая личность из тикета важнее заявленной
      // в кадре. Заявленная остаётся в силе только для соединений без
      // подтверждения — их дают клиентам, которые ещё не обновились.
      const prior = ws.deserializeAttachment();
      const memberId = prior?.bound ? prior.memberId : msg.memberId || null;
      // Исключённый мог держать тикет, взятый за секунду до исключения.
      if (this.isRemoved(memberId)) {
        ws.close(4403, 'removed');
        return;
      }
      ws.serializeAttachment({ memberId, bound: prior?.bound === true });
      if (memberId) {
        this.sql.exec(
          'INSERT INTO members (member_id, joined_at) VALUES (?, ?) ON CONFLICT(member_id) DO NOTHING',
          memberId,
          new Date().toISOString(),
        );
      }
      let since = Number(msg.lastSeq || 0);
      for (;;) {
        const page = this.backfill(since);
        ws.send(JSON.stringify({ type: 'backfill', ...page }));
        since = page.nextSince;
        if (!page.hasMore) break;
      }
      ws.send(JSON.stringify({
        type: 'ready',
        headSeq: this.headSeq(),
        online: this.onlineMemberIds(),
        name: this.roomName(),
        reads: this.allReads(),
        lastSeen: this.lastSeenMap(),
      }));
      this.broadcastPresence(); // остальным — что этот участник вошёл
      return;
    }
    if (msg.type === 'send') {
      // АВТОРА СТАВИТ СЕРВЕР, А НЕ ОТПРАВИТЕЛЬ. Раньше senderMemberId брался
      // прямо из кадра: любой участник группы (а токен группы есть у всех)
      // мог отправить сообщение от имени другого — переписка семьи, где
      // сообщение «от мамы» подделывается в одну строку. Содержимое зашифровано
      // групповым ключом, и ключ у всех участников, так что криптография от
      // своих здесь не защищает — защищает привязка к сессии: memberId уже
      // закреплён за соединением в hello и лежит в attachment.
      // Кадр без живой сессии (attachment пуст — соединение не представилось)
      // остаётся на своём заявленном авторе: это путь ДО hello, и ломать его
      // значило бы терять авторство у честных клиентов.
      const att = ws.deserializeAttachment();
      const res = await this.ingest(att?.memberId ? { ...msg, senderMemberId: att.memberId } : msg);
      ws.send(JSON.stringify({ type: 'ack', clientMsgId: msg.clientMsgId || null, itemId: res.itemId, seq: res.seq }));
      return;
    }
    if (msg.type === 'rename' && typeof msg.name === 'string') {
      const name = msg.name.trim().slice(0, 60);
      if (name) {
        this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'room_name', name);
        this.broadcastFrame({ type: 'name', name });
      }
      return;
    }
    if (msg.type === 'seen' && typeof msg.seq === 'number') {
      const att = ws.deserializeAttachment();
      if (att?.memberId) {
        this.sql.exec(
          'UPDATE members SET last_seen_seq = MAX(COALESCE(last_seen_seq, 0), ?) WHERE member_id = ?',
          msg.seq,
          att.memberId,
        );
        this.broadcastFrame({ type: 'read', memberId: att.memberId, seq: msg.seq });
      }
      return;
    }
    // «Печатает…» — эфемерный броадкаст остальным. В БД не пишется, офлайнам
    // не доставляется (индикатор живёт секунды — пуш ему не нужен).
    if (msg.type === 'typing') {
      const att = ws.deserializeAttachment();
      if (!att?.memberId) return;
      const frame = JSON.stringify({ type: 'typing', memberId: att.memberId });
      for (const sock of this.ctx.getWebSockets()) {
        if (sock === ws) continue;
        try {
          sock.send(frame);
        } catch {
          /* сокет закрывается */
        }
      }
      return;
    }
    // Сигналинг звонков (WebRTC): эфемерный релей — НЕ пишем в БД. data —
    // шифротекст (SDP/ICE, зашифрован семейным ключом). Адресуется конкретному
    // участнику (to). Если адресата нет онлайн и это приглашение (offer) —
    // шлём пуш-нудж «открой приложение, чтобы ответить».
    if (msg.type === 'signal') {
      const att = ws.deserializeAttachment();
      const from = att?.memberId || null;
      const frame = JSON.stringify({
        type: 'signal',
        from,
        to: msg.to ?? null,
        call: msg.call ?? null,
        kind: msg.kind ?? null,
        data: msg.data ?? null,
      });
      let delivered = false;
      for (const sock of this.ctx.getWebSockets()) {
        if (sock === ws) continue;
        const a = sock.deserializeAttachment();
        if (msg.to && a?.memberId !== msg.to) continue;
        try {
          sock.send(frame);
          delivered = true;
        } catch {
          /* сокет закрывается */
        }
      }
      if (!delivered && msg.kind === 'offer' && msg.to) {
        // ОДИН пуш на звонок (не серия): trackPendingCall вернёт true только на
        // первый недоставленный offer; повторные offer каждые 2.5с пуш не дублируют.
        if (this.trackPendingCall(msg.to, msg.call)) {
          this.ctx.waitUntil(this.pushCall(msg.to, msg.call));
        }
      }
      // Звонящий отменил (в т.ч. по таймауту «не ответили»), адресат так и не
      // подключился — заменяем «звонит» на «пропущенный звонок».
      if (!delivered && msg.kind === 'cancel' && msg.to) {
        this.ctx.waitUntil(this.pushMissedCall(msg.to, msg.call));
      }
      // Любой сигнал, кроме недоставленного offer, снимает страховку alarm'а:
      // доставленный offer — адресат онлайн, его клиент сам покажет исход;
      // cancel — missed уже ушёл строкой выше; answer/decline/busy/hangup —
      // адресат уже в приложении, «пропущенный» не нужен.
      if (msg.call && (msg.kind !== 'offer' || delivered)) {
        this.sql.exec('DELETE FROM meta WHERE k=?', `callpend:${msg.call}`);
      }
      return;
    }
  }

  roomName() {
    const r = this.sql.exec('SELECT v FROM meta WHERE k=?', 'room_name').toArray()[0];
    return r ? r.v : null;
  }

  allReads() {
    return this.sql
      .exec('SELECT member_id, last_seen_seq FROM members WHERE last_seen_seq IS NOT NULL')
      .toArray()
      .map((r) => ({ memberId: r.member_id, seq: r.last_seen_seq }));
  }

  // Время последнего выхода из сети по участникам (для «был(а) в сети …»).
  lastSeenMap() {
    const out = {};
    for (const r of this.sql
      .exec('SELECT member_id, last_online_at FROM members WHERE last_online_at IS NOT NULL')
      .toArray()) {
      out[r.member_id] = r.last_online_at;
    }
    return out;
  }

  broadcastFrame(obj) {
    const f = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(f);
      } catch {
        /* сокет закрывается */
      }
    }
  }

  webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (att?.memberId) {
      this.sql.exec('UPDATE members SET last_online_at = ? WHERE member_id = ?', new Date().toISOString(), att.memberId);
    }
    try {
      ws.close();
    } catch {
      /* уже закрыт */
    }
    this.broadcastPresence(); // участник ушёл — обновить статус у остальных
  }

  // === Web Push оффлайн-участникам (сигнал, не транспорт) ===
  async pushOffline(item, senderMemberId, kind = 'msg') {
    const online = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.memberId) online.add(att.memberId);
    }
    const vapid = {
      publicKey: this.env.VAPID_PUBLIC,
      privateKey: this.env.VAPID_PRIVATE,
      subject: this.env.VAPID_SUBJECT || 'mailto:noreply@life-hub.app',
    };
    if (!vapid.privateKey) return;
    const subs = this.sql
      .exec('SELECT member_id, push_sub FROM members WHERE push_sub IS NOT NULL AND member_id != ?', senderMemberId || '')
      .toArray();
    // Заголовок нейтральный, без названия группы. Название лежит на сервере
    // открытым текстом и попадает в уведомление на экран блокировки — то есть
    // видно любому, кто взял телефон в руки, и известно тому, кто держит
    // сервер. «Ремонт на Пушкина» или фамилия семьи — это утечка, ради которой
    // не стоит различать группы в шторке.
    // Тег с familyId остаётся: он не осмыслен для стороннего наблюдателя, но
    // не даёт уведомлениям двух групп схлопнуться в одно.
    const familyId = this.sql.exec('SELECT v FROM meta WHERE k=?', 'family_id').toArray()[0]?.v || '';
    const name = 'Семья';
    // Тег у каждого типа события свой: с общим тегом «задача выполнена» затирала
    // бы уведомление о новой задаче, и человек не узнал бы, что ему её поставили.
    const KIND = {
      msg: { body: 'Новое сообщение', tag: 'family-chat:' },
      task: { body: 'Новая общая задача', tag: 'family-task:' },
      'task-done': { body: 'Общая задача выполнена', tag: 'family-task-done:' },
    };
    const k = KIND[kind] || KIND.msg;
    const bodyText = k.body;
    const tag = k.tag + (familyId || 'all');
    for (const m of subs) {
      if (online.has(m.member_id)) continue;
      try {
        const sub = JSON.parse(m.push_sub);
        const { endpoint, headers, body } = await buildPushRequest({
          subscription: sub,
          payload: JSON.stringify({ title: name, body: bodyText, family: true, familyId, tag }),
          vapid,
          ttl: 3600,
          urgency: 'high',
        });
        await fetch(endpoint, { method: 'POST', headers, body });
      } catch {
        /* мёртвая подписка — игнор */
      }
    }
  }

  // ICE-серверы. STUN бесплатен и безлимитен. TURN (relay для сетей за
  // симметричным NAT/VPN, где P2P не пробивается), по приоритету:
  //   1) Cloudflare Realtime (секреты TURN_KEY_*; 1000 ГБ/мес, нужна подписка);
  //   2) Metered.ca (секреты METERED_DOMAIN + METERED_API_KEY; 20 ГБ/мес
  //      бесплатно, без карты);
  //   3) без секретов — только STUN (анонимный Open Relay мёртв — проверено).
  // Медиа шифруется SRTP — ретранслятор содержимого не видит.
  async iceServers() {
    // Один STUN, а не два: браузер опрашивает ВСЕ сконфигурированные серверы,
    // и лишний удлиняет сбор кандидатов (предупреждение в документации
    // Nextcloud Talk; у Firefox известны зависания сбора на 12-13 секунд).
    // Google-STUN убран — Cloudflare отдаёт свой в том же ответе.
    const servers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
    const keyId = this.env.TURN_KEY_ID;
    const apiToken = this.env.TURN_KEY_API_TOKEN;
    if (keyId && apiToken) {
      try {
        const r = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
            // TTL с запасом «дольше самого длинного звонка» (рекомендация
            // Cloudflare): протухшие посреди разговора креды — это отказ
            // ретранслятора ровно в момент, когда он нужен для восстановления.
            body: JSON.stringify({ ttl: 28800 }),
          },
        );
        if (r.ok) {
          const data = await r.json();
          if (data.iceServers) {
            servers.push(...orderTurn(data.iceServers));
            return servers;
          }
        }
      } catch {
        /* Cloudflare TURN недоступен — пробуем Metered ниже */
      }
    }
    const meteredDomain = this.env.METERED_DOMAIN;
    const meteredKey = this.env.METERED_API_KEY;
    if (meteredDomain && meteredKey) {
      try {
        const r = await fetch(
          `https://${meteredDomain}/api/v1/turn/credentials?apiKey=${meteredKey}`,
        );
        if (r.ok) {
          const list = await r.json();
          if (Array.isArray(list) && list.length) servers.push(...list);
        }
      } catch {
        /* Metered недоступен — остаёмся на STUN */
      }
    }
    return servers;
  }

  // Пуш о входящем звонке участнику, которого нет онлайн (WS мёртв). Один на
  // звонок (дедуп по callpend в trackPendingCall): юзер попросил без серии —
  // единственное уведомление, дальше исход решает alarm/cancel («пропущенный»).
  async pushCall(toMemberId, callId) {
    const row = this.sql
      .exec('SELECT push_sub FROM members WHERE member_id=? AND push_sub IS NOT NULL', toMemberId)
      .toArray()[0];
    if (!row) return;
    let sub;
    try {
      sub = JSON.parse(row.push_sub);
    } catch {
      return;
    }
    await this.sendPushTo(sub, {
      // Без названия группы: экран блокировки виден любому, кто рядом, а само
      // название хранится на сервере открытым текстом — двойная утечка ради
      // строки, которую всё равно видно уже в приложении.
      title: 'Входящий звонок',
      body: 'Откройте, чтобы ответить',
      family: true,
      familyId: this.familyIdMeta(),
      call: true,
      tag: 'family-call:' + (callId || this.familyIdMeta() || 'all'),
    }, 10); // короткий TTL: опоздавший «звонит» после конца ринга не нужен
  }

  // «Пропущенный звонок»: тот же tag — на Android заменяет карточку «звонит».
  async pushMissedCall(toMemberId, callId) {
    const row = this.sql
      .exec('SELECT push_sub FROM members WHERE member_id=? AND push_sub IS NOT NULL', toMemberId)
      .toArray()[0];
    if (!row) return;
    let sub;
    try {
      sub = JSON.parse(row.push_sub);
    } catch {
      return;
    }
    await this.sendPushTo(sub, {
      title: 'Пропущенный звонок',
      body: 'Откройте приложение',
      family: true,
      familyId: this.familyIdMeta(),
      missed: true,
      tag: 'family-call:' + (callId || this.familyIdMeta() || 'all'),
    }, 3600);
  }

  familyIdMeta() {
    return this.sql.exec('SELECT v FROM meta WHERE k=?', 'family_id').toArray()[0]?.v || '';
  }

  // Страховка от «вечной карточки звонит»: если приложение звонящего умрёт до
  // таймаута ринга (свернул PWA — iOS убивает фон), cancel не придёт и missed
  // некому послать. Запоминаем НАЧАЛО дозвона и alarm'ом добиваем сами.
  // Возвращает true, если это ПЕРВЫЙ offer звонка (маркер «пуш ещё не слали»).
  trackPendingCall(toMemberId, callId) {
    if (!callId) return false;
    const k = `callpend:${callId}`;
    const exists = this.sql.exec('SELECT 1 FROM meta WHERE k=? LIMIT 1', k).toArray()[0];
    if (!exists) {
      this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?)', k, JSON.stringify({ to: toMemberId, at: Date.now() }));
    }
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + CALL_PENDING_TTL_MS + 3000));
    return !exists;
  }

  async alarm() {
    const rows = this.sql.exec("SELECT k, v FROM meta WHERE k LIKE 'callpend:%'").toArray();
    let nextInMs = null;
    for (const r of rows) {
      let p;
      try {
        p = JSON.parse(r.v);
      } catch {
        this.sql.exec('DELETE FROM meta WHERE k=?', r.k);
        continue;
      }
      const age = Date.now() - (p.at || 0);
      if (age >= CALL_PENDING_TTL_MS) {
        this.sql.exec('DELETE FROM meta WHERE k=?', r.k);
        await this.pushMissedCall(p.to, r.k.slice('callpend:'.length));
      } else {
        const rem = CALL_PENDING_TTL_MS - age;
        nextInMs = nextInMs == null ? rem : Math.min(nextInMs, rem);
      }
    }
    // Ещё не протухшие дозвоны (перекрывающиеся звонки) — перевзводим будильник.
    if (nextInMs != null) await this.ctx.storage.setAlarm(Date.now() + nextInMs + 1000);
  }

  async sendPushTo(sub, payload, ttl) {
    const vapid = {
      publicKey: this.env.VAPID_PUBLIC,
      privateKey: this.env.VAPID_PRIVATE,
      subject: this.env.VAPID_SUBJECT || 'mailto:noreply@life-hub.app',
    };
    if (!vapid.privateKey) return;
    try {
      const { endpoint, headers, body } = await buildPushRequest({
        subscription: sub,
        payload: JSON.stringify(payload),
        vapid,
        ttl,
        urgency: 'high',
      });
      await fetch(endpoint, { method: 'POST', headers, body });
    } catch {
      /* мёртвая подписка — игнор */
    }
  }

  prune() {
    const cutoff = new Date(Date.now() - MSG_RETENTION_DAYS * 86400_000).toISOString();
    this.sql.exec('DELETE FROM items WHERE channel=? AND created_at < ?', 'msg', cutoff);
    // сверх лимита по количеству — оставить только последние MSG_RETENTION_MAX
    const total = this.sql.exec("SELECT COUNT(*) AS c FROM items WHERE channel='msg'").toArray()[0].c;
    if (total > MSG_RETENTION_MAX) {
      this.sql.exec(
        "DELETE FROM items WHERE channel='msg' AND seq NOT IN (SELECT seq FROM items WHERE channel='msg' ORDER BY seq DESC LIMIT ?)",
        MSG_RETENTION_MAX,
      );
    }
  }
}

/**
 * Порядок TURN-адресов решает, дозвонится ли человек с мобильного интернета.
 * Логика повторяет src/lib/family/callTuning.ts (orderTurnUrls) — там же
 * подробное обоснование и тесты. Дублируется намеренно: воркер собирается
 * отдельно от приложения и импортировать из src не может.
 */
function orderTurn(ice) {
  const list = Array.isArray(ice) ? ice : [ice];
  return list.map((s) => {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(
      (u) => typeof u === 'string' && !/:53(\?|$)/.test(u),
    );
    const rank = (u) => {
      if (u.startsWith('turns:') && u.includes(':443')) return 0;
      if (u.startsWith('turns:')) return 1;
      if (u.startsWith('turn:') && u.includes('udp')) return 2;
      if (u.startsWith('turn:')) return 3;
      return 4;
    };
    const ordered = [...urls].sort((a, b) => rank(a) - rank(b));
    if (!ordered.some((u) => u.startsWith('turns:') && u.includes(':443'))) {
      const anyTls = ordered.find((u) => u.startsWith('turns:'));
      if (anyTls) ordered.unshift(anyTls.replace(/:\d+/, ':443'));
    }
    return { ...s, urls: ordered };
  });
}
