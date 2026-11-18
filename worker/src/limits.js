// Ограничения нагрузки: защита общего бесплатного плана от одного шумного
// клиента (или чужого скрипта).
//
// Два слоя:
//  1. Частота — встроенный Rate Limiting Cloudflare (биндинги RL_* в
//     wrangler.toml). Счётчики живут в памяти на краю сети, D1 и KV не тратят.
//     Биндинга нет (тесты, старый деплой) — пропускаем: ограничение не должно
//     уметь сломать обмен.
//  2. Суточные потолки — счётчики в D1 (таблица usage_counters): сколько
//     аккаунтов завели с одного адреса и сколько запросов к ИИ сделал аккаунт
//     и адрес. Встроенный лимитер считает только окна по 10/60 с, сутки ему не
//     по силам.
//
// IP открытым текстом не хранится: в ключ идёт SHA-256 от адреса с солью дня,
// завтра тот же адрес даёт другой хеш, и связать дни между собой нельзя.

const DEFAULTS = {
  NEW_ACCOUNTS_PER_IP_DAY: 20,
  AI_CALLS_PER_ACCOUNT_DAY: 60,
  AI_CALLS_PER_IP_DAY: 200,
};

/** Число из переменной воркера или умолчание. 0 и мусор — умолчание. */
export function limitOf(env, name) {
  const n = Number.parseInt(env?.[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULTS[name];
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0].trim() || '';
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Ключ адреса на сегодня: хеш, а не сам IP. */
export async function ipKey(request) {
  const ip = clientIp(request);
  return ip ? (await sha256hex(`${today()}|${ip}`)).slice(0, 32) : '';
}

/** Частотный лимит через биндинг Cloudflare. true — можно. */
export async function allowRate(binding, key) {
  if (!binding || typeof binding.limit !== 'function' || !key) return true;
  try {
    const { success } = await binding.limit({ key });
    return success !== false;
  } catch {
    return true; // сбой лимитера не должен ронять запрос
  }
}

let countersReady = false;
async function ensureCounters(env) {
  if (countersReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS usage_counters (
       k TEXT NOT NULL,
       day TEXT NOT NULL,
       n INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (k, day)
     )`,
  ).run();
  countersReady = true;
}

/** Текущее значение суточного счётчика. */
export async function readCounter(env, k) {
  await ensureCounters(env);
  const row = await env.DB.prepare('SELECT n FROM usage_counters WHERE k = ? AND day = ?').bind(k, today()).first();
  return Number(row?.n ?? 0);
}

/** +1 к суточному счётчику. */
export async function bumpCounter(env, k) {
  await ensureCounters(env);
  await env.DB.prepare(
    `INSERT INTO usage_counters (k, day, n) VALUES (?, ?, 1)
     ON CONFLICT(k, day) DO UPDATE SET n = n + 1`,
  )
    .bind(k, today())
    .run();
}

/** Стереть вчерашние и более старые счётчики (зовёт cron раз в час). */
export async function pruneCounters(env) {
  await ensureCounters(env);
  await env.DB.prepare('DELETE FROM usage_counters WHERE day < ?').bind(today()).run();
}

/** Можно ли завести новый аккаунт с этого адреса сегодня. Счётчик
 *  увеличивает только успешная регистрация — см. noteNewAccount. */
export async function canCreateAccount(env, request) {
  const ip = await ipKey(request);
  if (!ip) return true;
  return (await readCounter(env, `new:${ip}`)) < limitOf(env, 'NEW_ACCOUNTS_PER_IP_DAY');
}

export async function noteNewAccount(env, request) {
  const ip = await ipKey(request);
  if (ip) await bumpCounter(env, `new:${ip}`);
}

/** Суточный потолок запросов к ИИ: на аккаунт и на адрес (аккаунт ассистента
 *  заводится на телефоне сам, очистил хранилище — новый, поэтому одного
 *  потолка на аккаунт мало). Аккаунты из AI_ALLOWED_ACCOUNTS — без потолка.
 *  Возвращает null, если можно, иначе причину. Засчитывает вызов сразу. */
export async function takeAiCall(env, request, accountId) {
  const allowed = (env.AI_ALLOWED_ACCOUNTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.includes(accountId)) return null;
  const ip = await ipKey(request);
  if ((await readCounter(env, `ai:${accountId}`)) >= limitOf(env, 'AI_CALLS_PER_ACCOUNT_DAY')) return 'account';
  if (ip && (await readCounter(env, `aiip:${ip}`)) >= limitOf(env, 'AI_CALLS_PER_IP_DAY')) return 'ip';
  await bumpCounter(env, `ai:${accountId}`);
  if (ip) await bumpCounter(env, `aiip:${ip}`);
  return null;
}
