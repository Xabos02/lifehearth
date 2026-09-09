// /account/check — вопрос «есть ли такой аккаунт», на который сервер обязан
// отвечать честно и НЕ заводить аккаунт заодно.
//
// Дефект, который это закрывает: авторизация обмена доверяет первому
// обращению — незнакомый accountId регистрируется молча (trust on first use).
// Для обмена это правильно, а для восстановления по ключу оказалось ловушкой:
// человек с верным ключом от аккаунта, которого на сервере нет (сервер
// сменили, базу сбросили), видел «Устройство подключено» и пустое приложение.
// Успех и полная потеря выглядели одинаково — и следующим шагом он мог
// затереть облачную копию снимком пустого телефона.

import { describe, expect, it, vi } from 'vitest';

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

/** SHA-256 в hex — так сервер хранит токен. */
async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Мок D1: `account` — строка в accounts (null = аккаунта нет), `records` —
 *  сколько записей под ним лежит. Все INSERT записываются, чтобы поймать
 *  случайную регистрацию. */
function makeDb(account: { tokenHash: string } | null, records = 0) {
  const inserts: string[] = [];
  return {
    inserts,
    prepare(sql: string) {
      if (sql.startsWith('INSERT')) inserts.push(sql);
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('FROM accounts')) return account ? { token_hash: account.tokenHash } : null;
              if (sql.includes('COUNT(*)')) return { n: records };
              return null;
            },
            async run() {
              return {};
            },
          };
        },
      };
    },
  };
}

async function check(db: ReturnType<typeof makeDb>, token = 'tok-1') {
  return worker.default.fetch(
    new Request('https://life-hub-push.workers.dev/account/check', {
      headers: { Origin: ORIGIN, 'X-Account': 'acc-1', Authorization: `Bearer ${token}` },
    }),
    { ALLOW_ORIGIN: ORIGIN, DB: db },
    { waitUntil: () => {} },
  );
}

describe('/account/check', () => {
  it('аккаунт есть — отвечает, сколько записей под ним лежит', async () => {
    const db = makeDb({ tokenHash: await sha256hex('tok-1') }, 311);
    const res = await check(db);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: true, records: 311 });
  });

  it('аккаунта нет — говорит «нет» и НЕ заводит его', async () => {
    const db = makeDb(null);
    const res = await check(db);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: false });
    // Главное в этом тесте: ни одной регистрации. Обычная авторизация обмена
    // на этом же месте сделала бы INSERT INTO accounts.
    expect(db.inserts).toEqual([]);
  });

  it('ключ от чужого токена — 401, а не «аккаунта нет»', async () => {
    const db = makeDb({ tokenHash: await sha256hex('другой-токен') });
    const res = await check(db, 'tok-1');
    expect(res.status).toBe(401);
    expect(db.inserts).toEqual([]);
  });

  it('без заголовков доступа — 401', async () => {
    const db = makeDb(null);
    const res = await worker.default.fetch(
      new Request('https://life-hub-push.workers.dev/account/check', { headers: { Origin: ORIGIN } }),
      { ALLOW_ORIGIN: ORIGIN, DB: db },
      { waitUntil: () => {} },
    );
    expect(res.status).toBe(401);
  });
});
