// Сопряжение устройств: встреча через сервер вместо кода с ключом внутри.
//
// Дефект, который здесь закрыт: код сопряжения СОДЕРЖАЛ ключ шифрования
// аккаунта и жил вечно. Скриншот QR в галерее, код в буфере, отправленный себе
// в мессенджер — всё это открывало доступ ко всем данным когда угодно. При
// этом тот же код служил резервной копией доступа, поэтому просто сделать его
// одноразовым было нельзя: люди сохраняют его на случай потери телефона.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { db } = await import('../db/db');
const { generateKey, exportKeyRaw, decodeMeet, decodePairing } = await import('./crypto');
const { getBackupCode, startPairing, awaitPairing, connectSync } = await import('./sync');

const realFetch = globalThis.fetch;

/** Сервер встречи в памяти: та же логика, что в воркере, — первый ответ
 *  побеждает, конверт выдаётся один раз. */
function mockPairServer(opts: { accountExists?: boolean; records?: number } = {}) {
  const meets = new Map<string, { pubA: string; pubB?: string; sealed?: string }>();
  const accountExists = opts.accountExists ?? true;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const res = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

    // Восстановление по сохранённому ключу сперва спрашивает, есть ли такой
    // аккаунт: сервер регистрирует незнакомый молча, и без этой проверки
    // человек с ключом от несуществующего аккаунта видел успех и пустоту.
    if (url.pathname === '/account/check') {
      return accountExists ? res({ exists: true, records: opts.records ?? 0 }) : res({ exists: false });
    }
    if (url.pathname === '/pair/offer') {
      meets.set(body.pairId, { pubA: body.pubA });
      return res({ ok: true });
    }
    if (url.pathname === '/pair/answer') {
      const m = meets.get(body.pairId);
      if (!m) return res({ error: 'expired' }, 404);
      if (m.pubB) return res({ error: 'taken' }, 409);
      m.pubB = body.pubB;
      return res({ ok: true, pubA: m.pubA });
    }
    if (url.pathname === '/pair/state') {
      const m = meets.get(url.searchParams.get('pairId') ?? '');
      if (!m) return res({ error: 'expired' }, 404);
      return res({ pubB: m.pubB ?? null, sealed: Boolean(m.sealed) });
    }
    if (url.pathname === '/pair/seal') {
      const m = meets.get(body.pairId);
      if (!m) return res({ error: 'expired' }, 404);
      m.sealed = body.sealed;
      return res({ ok: true });
    }
    if (url.pathname === '/pair/claim') {
      const id = url.searchParams.get('pairId') ?? '';
      const m = meets.get(id);
      if (!m?.sealed) return res({ sealed: null });
      meets.delete(id); // одноразово, как на сервере
      return res({ sealed: m.sealed });
    }
    return res({ ok: true });
  }) as typeof fetch;
  return meets;
}

async function seedAccount() {
  await db.sync.put({
    id: 'config',
    accountId: 'acc-1',
    authToken: 'token-secret-1',
    key: await generateKey(),
    enabled: true,
    lastPullAt: '',
    lastPushAt: '',
    lastSyncedAt: '',
  });
}

beforeEach(async () => {
  await db.sync.clear();
  mockPairServer();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('код для второго устройства', () => {
  it('не содержит ни ключа, ни токена — только номер встречи и одноразовый ключ', async () => {
    await seedAccount();
    const cfg = await db.sync.get('config');
    const keyRaw = await exportKeyRaw(cfg!.key);

    const meet = await startPairing();
    expect(meet).not.toBeNull();

    // Ровно то, чем этот код отличается от прежнего: секретов внутри нет.
    expect(meet!.code).not.toContain(keyRaw);
    expect(meet!.code).not.toContain('token-secret-1');
    expect(meet!.code).not.toContain('acc-1');
    const parsed = decodeMeet(meet!.code);
    expect(parsed?.pairId).toBe(meet!.pairId);
    // И это не пакет доступа: старый разбор его не принимает.
    expect(() => decodePairing(meet!.code)).toThrow();
  });

  it('второе устройство получает доступ, пройдя встречу целиком', async () => {
    await seedAccount();
    const cfg = await db.sync.get('config');
    const keyRaw = await exportKeyRaw(cfg!.key);
    const meet = await startPairing();

    // Первое устройство ждёт ответа и кладёт конверт; второе — подключается.
    const waiting = awaitPairing(meet!.pairId, meet!.priv);
    await db.sync.clear(); // эмулируем чистое второе устройство
    await connectSync(meet!.code);
    expect(await waiting).toBe(true);

    const got = await db.sync.get('config');
    expect(got?.accountId).toBe('acc-1');
    expect(got?.authToken).toBe('token-secret-1');
    expect(await exportKeyRaw(got!.key)).toBe(keyRaw);
  });

  it('второй раз тем же кодом подключиться нельзя', async () => {
    await seedAccount();
    const meet = await startPairing();
    const waiting = awaitPairing(meet!.pairId, meet!.priv);
    await connectSync(meet!.code);
    await waiting;

    // Подсмотревший QR приходит следом — встречи уже нет.
    await expect(connectSync(meet!.code)).rejects.toThrow();
  });
});

describe('резервная копия доступа', () => {
  it('осталась прежним пакетом с ключом — восстановление не сломано', async () => {
    await seedAccount();
    const cfg = await db.sync.get('config');
    const backup = await getBackupCode();
    expect(backup).toBeTruthy();

    const parsed = decodePairing(backup!);
    expect(parsed.accountId).toBe('acc-1');
    expect(parsed.key).toBe(await exportKeyRaw(cfg!.key));

    // И по нему по-прежнему можно подключиться — без всякой встречи.
    await db.sync.clear();
    const r = await connectSync(backup!);
    expect((await db.sync.get('config'))?.accountId).toBe('acc-1');
    // Сервер сказал, сколько записей нашлось, — это увидит человек.
    expect(r.records).toBe(0);
  });

  it('сервер старой версии (404 на проверку) — восстановление всё равно проходит', async () => {
    await seedAccount();
    const backup = await getBackupCode();
    await db.sync.clear();

    // Порядок выкатки не должен решать судьбу человека с ключом в руках:
    // пока сервер не знает маршрута проверки, идём прежним путём.
    globalThis.fetch = realFetch;
    const old = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/account/check') return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = old as unknown as typeof fetch;

    await connectSync(backup!);
    expect((await db.sync.get('config'))?.accountId).toBe('acc-1');
  });

  it('ключ верный, а аккаунта на сервере нет — говорим прямо, а не «подключено»', async () => {
    await seedAccount();
    const backup = await getBackupCode();
    await db.sync.clear();

    // Тот случай, ради которого проверка и заведена: сервер сменили или базу
    // сбросили. Раньше сервер регистрировал незнакомый аккаунт молча, человек
    // видел «Устройство подключено» и пустое приложение.
    globalThis.fetch = realFetch;
    mockPairServer({ accountExists: false });

    await expect(connectSync(backup!)).rejects.toThrow(/аккаунта с этим ключом/i);
    // И конфиг не сохранён: устройство не считает себя подключённым.
    expect(await db.sync.get('config')).toBeUndefined();
  });
});
