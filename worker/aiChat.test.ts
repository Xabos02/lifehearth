// /ai/chat: кого пускать к живым моделям и куда отправлять запрос.
//
// Допуск. Бесплатные модели Workers AI открыты любому аккаунту — ассистент без
// настроек (решение 18.11.2026). Платный ключ провайдера — только по списку:
// пустой AI_ALLOWED_ACCOUNTS раньше означал «пускать всех», а деплой воркера без
// keep_vars стирает переменные дашборда — так прокси оказался открыт любому.
// Теперь пустой список — отказ.
//
// Маршрут. Модели с префиксом @cf/ идут в Workers AI через binding, остальные —
// к провайдеру по AI_PROVIDER_URL. Кончился дневной бесплатный лимит (3036) —
// отдельный ответ, чтобы клиент сказал «обновится в 03:00», а не «подождите».

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

const worker = await import('./src/index.js');
const ORIGIN = 'https://xabos02.github.io';
const GEMMA = '@cf/google/gemma-4-26b-a4b-it';

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Аккаунт acc-1 с токеном tok-1 уже зарегистрирован. */
async function makeEnv(extra: Record<string, unknown> = {}) {
  const hash = await sha256hex('tok-1');
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => ({ token_hash: hash }),
    run: async () => ({}),
  });
  const DB = { prepare: (sql: string) => stmt(sql), batch: async () => [] };
  return { ALLOW_ORIGIN: ORIGIN, DB, ...extra };
}

function post(env: unknown, body: string, headers: Record<string, string> = {}) {
  return worker.default.fetch(
    new Request('https://life-hub-push.workers.dev/ai/chat', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'X-Account': 'acc-1', Authorization: 'Bearer tok-1', ...headers },
      body,
    }),
    env,
    { waitUntil: () => {} },
  );
}

function chat(env: unknown, model: string, tools?: unknown[]) {
  return post(env, JSON.stringify({ model, messages: [{ role: 'user', content: 'привет' }], systemPrompt: 'кратко', tools }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/ai/chat', () => {
  it('пустой список разрешённых — платной модели отказ, бесплатная отвечает', async () => {
    const run = vi.fn(async () => new Response('data: [DONE]\n\n').body);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = await makeEnv({ AI: { run }, AI_PROVIDER_KEY: 'k', AI_PROVIDER_URL: 'https://p.test/v1' });
    expect((await chat(env, 'anthropic/claude-sonnet-5')).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await chat(env, GEMMA)).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('@cf/ — в Workers AI потоком, с инструментами и своим потолком токенов; провайдер не трогается; чужой @cf/ — отказ', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
    const run = vi.fn(async () => new Response(sse).body);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = await makeEnv({ AI: { run }, AI_PROVIDER_KEY: 'k', AI_PROVIDER_URL: 'https://p.test/v1' });
    const tools = [{ type: 'function', function: { name: 'list_tasks', parameters: { type: 'object', properties: {} } } }];

    const res = await chat(env, GEMMA, tools);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(await res.text()).toBe(sse);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(GEMMA, {
      messages: [
        { role: 'system', content: 'кратко' },
        { role: 'user', content: 'привет' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 8192,
      tools,
    });

    run.mockClear();
    expect((await chat(env, '@cf/meta/some-heavy-model')).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('дневной лимит Workers AI (3036) — 429 quota; перегрузка (3040) — 503 busy; прочий сбой — 502 provider', async () => {
    const env = await makeEnv({ AI: { run: vi.fn() } });
    env.AI.run.mockRejectedValueOnce(new Error('3036: You have used up your daily free allocation of 10,000 neurons.'));
    const limited = await chat(env, GEMMA);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toBe('quota');

    env.AI.run.mockRejectedValueOnce(new Error('3040: Capacity temporarily exceeded'));
    const busy = await chat(env, GEMMA);
    expect(busy.status).toBe(503);
    expect((await busy.json()).error).toBe('busy');

    env.AI.run.mockRejectedValueOnce(new Error('5007: No such model'));
    const failed = await chat(env, GEMMA);
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe('provider');
  });

  it('тело больше 1 000 000 байт — 413, хотя символов меньше (кириллица — два байта)', async () => {
    const run = vi.fn();
    const env = await makeEnv({ AI: { run } });
    const body = JSON.stringify({ model: GEMMA, messages: [{ role: 'user', content: 'я'.repeat(600_000) }] });
    expect(body.length).toBeLessThan(1_000_000);
    // Браузер ставит Content-Length сам, Request в Node — нет.
    const res = await post(env, body, { 'Content-Length': String(new TextEncoder().encode(body).length) });
    expect(res.status).toBe(413);
    expect(run).not.toHaveBeenCalled();
  });
});
