// Рассылка «вышло обновление» — одна на версию, сколько бы раз её ни звали.
//
// Раньше «менялась ли версия» решал CI, сравнивая changelog с предыдущим
// коммитом. Стоило деплою с новой версией упасть на тестах — следующий,
// зелёный, видел «не менялась» и молчал: так 1.20–1.22 уехали на прод без
// уведомления. Теперь помнит воркер, а CI зовёт после каждого удачного деплоя.

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

/** Окружение из заглушек: KV в памяти, D1 без подписок, VAPID без ключа —
 *  сама отправка тут не важна, важен только учёт версии. */
function makeEnv() {
  const kv = new Map<string, string>();
  return {
    kv,
    env: {
      UPDATE_TOKEN: 'secret',
      REMINDERS: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => void kv.set(k, v),
      },
      DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }), all: async () => ({ results: [] }) }) },
    },
  };
}

async function notify(env: unknown, body: object) {
  const req = new Request('https://w.test/notify-update', {
    method: 'POST',
    headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await (worker.default as { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> }).fetch(
    req,
    env,
    { waitUntil() {} },
  );
  return { status: res.status, data: (await res.json()) as { ok: boolean; sent: number; skipped?: string } };
}

describe('/notify-update — одна рассылка на версию', () => {
  it('первый вызов с версией рассылает и запоминает её, второй — пропуск', async () => {
    const { env, kv } = makeEnv();
    const first = await notify(env, { body: 'Текст', version: '1.22.0' });
    expect(first.status).toBe(200);
    expect(first.data.skipped).toBeUndefined();
    expect(kv.get('update:last-notified-version')).toBe('1.22.0');

    const again = await notify(env, { body: 'Текст', version: '1.22.0' });
    expect(again.data).toMatchObject({ ok: true, sent: 0, skipped: 'same-version' });
  });

  it('новая версия после запомненной рассылается снова', async () => {
    const { env, kv } = makeEnv();
    kv.set('update:last-notified-version', '1.22.0');
    const res = await notify(env, { body: 'Текст', version: '1.23.0' });
    expect(res.data.skipped).toBeUndefined();
    expect(kv.get('update:last-notified-version')).toBe('1.23.0');
  });

  it('без версии — как раньше: рассылает всегда и ничего не запоминает', async () => {
    const { env, kv } = makeEnv();
    const res = await notify(env, { body: 'Текст' });
    expect(res.data.skipped).toBeUndefined();
    expect(kv.size).toBe(0);
  });

  it('чужой токен — 401, версия не трогается', async () => {
    const { env, kv } = makeEnv();
    const req = new Request('https://w.test/notify-update', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
      body: JSON.stringify({ version: '9.9.9' }),
    });
    const res = await (worker.default as { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> }).fetch(req, env, { waitUntil() {} });
    expect(res.status).toBe(401);
    expect(kv.size).toBe(0);
  });
});
