// LifeHearth бэкенд (Cloudflare Worker) — пуши + E2E-синхронизация.
// HTTP:
//   /health                  — проверка живости
//   /schedule, /cancel       — напоминания (push), KV REMINDERS
//   /sync/push, /sync/pull   — синхронизация записей, D1 (только шифротекст)
// Cron (раз в минуту): шлёт пуши, у которых наступило время.

import { buildPushRequest } from './webpush.js';
export { FamilyRoom } from './familyRoom.js';

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // X-Family-Owner обязателен: это непростой заголовок, браузер шлёт на него
  // preflight OPTIONS, и без него в этом списке запрос на /family/remove до
  // воркера не долетает вообще — fetch падает TypeError «Failed to fetch»,
  // человек видит «проверьте связь» и думает, что дело в интернете.
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Account, X-Family-Owner',
  'Access-Control-Max-Age': '86400',
});

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Авторизация синка: X-Account = accountId, Authorization: Bearer <token>.
// Возвращает accountId при успехе, иначе null. Первое обращение с новым
// (неугадываемым) accountId регистрирует пару — trust on first use.
async function authAccount(request, env) {
  const accountId = request.headers.get('X-Account');
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!accountId || !token) return null;
  const hash = await sha256hex(token);
  const row = await env.DB.prepare('SELECT token_hash FROM accounts WHERE account_id = ?')
    .bind(accountId)
    .first();
  if (!row) {
    await env.DB.prepare('INSERT INTO accounts (account_id, token_hash, created_at) VALUES (?, ?, ?)')
      .bind(accountId, hash, new Date().toISOString())
      .run();
    return accountId;
  }
  return row.token_hash === hash ? accountId : null;
}

const PULL_LIMIT = 500;
// Потолок страницы по объёму. Строки бывают очень разные: обычная задача —
// сотни байт, а кусок вложения заметки — больше полумегабайта после шифрования.
// Пятьсот таких кусков в одном ответе — это сотни мегабайт, которые не
// доедут никогда: обмен падает на каждой попытке, курсор стоит, и синхронизация
// мертва навсегда. Курсор составной (updated_at|id), поэтому дорезать страницу
// безопасно — остаток приедет следующей.
const PULL_MAX_BYTES = 3 * 1024 * 1024;

// Таблицу резервных копий создаём лениво (миграции D1 в этом проекте применяются
// вручную; ленивое создание убирает этот шаг — фича работает сразу после деплоя).
let backupTableReady = false;
let backupMetaReady = false;

// Манифест копии: несколько чисел о её содержимом, зашифрованных клиентом.
//
// Он нужен, чтобы устройство перед перезаписью могло понять, не потеряет ли
// облачная копия данные, — НЕ скачивая её целиком. Раньше для этой проверки
// качалась вся копия, и чем она больше, тем вероятнее было, что скачивание
// упадёт. А падение проверки означало «пиши так»: защита молча отключалась
// ровно тогда, когда была нужнее всего.
async function ensureBackupMeta(env) {
  if (backupMetaReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS backup_meta (
       account_id TEXT PRIMARY KEY,
       manifest TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
  ).run();
  backupMetaReady = true;
}
async function ensureBackupTable(env) {
  if (backupTableReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS backups (
       account_id TEXT NOT NULL,
       chunk INTEGER NOT NULL DEFAULT 0,
       updated_at TEXT NOT NULL,
       ciphertext TEXT NOT NULL,
       PRIMARY KEY (account_id, chunk)
     )`,
  ).run();
  backupTableReady = true;
}

/** Встреча двух устройств живёт пятнадцать минут: хватает, чтобы дойти до
 *  второго телефона и открыть нужный экран, и мало, чтобы подсмотренный QR
 *  пригодился кому-то потом. */
const PAIR_TTL_MS = 15 * 60_000;

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || '*';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });

    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') return json({ ok: true }, 200, origin);

      // === Напоминания (push) — хранятся в D1 (cron делает SELECT, не KV list) ===
      if (url.pathname === '/schedule' && request.method === 'POST') {
        const { taskId, fireAt, title, body, subscription } = await request.json();
        if (!taskId || typeof fireAt !== 'number' || !subscription?.endpoint) {
          return json({ error: 'bad request' }, 400, origin);
        }
        await env.DB.prepare(
          'INSERT OR REPLACE INTO reminders (task_id, fire_at, title, body, subscription) VALUES (?, ?, ?, ?, ?)',
        )
          .bind(taskId, fireAt, title || '', body || '', JSON.stringify(subscription))
          .run();
        return json({ ok: true }, 200, origin);
      }

      if (url.pathname === '/cancel' && request.method === 'POST') {
        const { taskId } = await request.json();
        if (taskId) await env.DB.prepare('DELETE FROM reminders WHERE task_id = ?').bind(taskId).run();
        return json({ ok: true }, 200, origin);
      }

      // Регистрация подписки в глобальный список (для рассылки об обновлении).
      if (url.pathname === '/push-register' && request.method === 'POST') {
        const { subscription } = await request.json();
        if (subscription?.endpoint) {
          await env.DB.prepare('INSERT OR REPLACE INTO push_subs (endpoint, sub, created_at) VALUES (?, ?, ?)')
            .bind(subscription.endpoint, JSON.stringify(subscription), new Date().toISOString())
            .run();
        }
        return json({ ok: true }, 200, origin);
      }

      // Рассылка «вышло обновление» всем подписанным устройствам (по секрету).
      if (url.pathname === '/notify-update' && request.method === 'POST') {
        if ((request.headers.get('Authorization') || '') !== `Bearer ${env.UPDATE_TOKEN}`) {
          return json({ error: 'unauthorized' }, 401, origin);
        }
        // Опциональный текст «что нового»; иначе — текст по умолчанию.
        let custom = {};
        try {
          custom = await request.json();
        } catch {
          /* тела нет */
        }
        const notifyBody =
          custom && typeof custom.body === 'string' && custom.body.trim()
            ? custom.body.trim().slice(0, 140)
            : DEFAULT_UPDATE_TEXT;
        const sent = await broadcastUpdate(env, notifyBody);
        return json({ ok: true, sent }, 200, origin);
      }

      // === Синхронизация (E2E) ===
      // === Сопряжение устройств: встреча двух телефонов через сервер ===
      //
      // Зачем понадобилось. Раньше код сопряжения СОДЕРЖАЛ ключ шифрования
      // аккаунта и жил вечно: кто увидел QR (скриншот в галерее, код в буфере,
      // пересланный себе в мессенджер) — получил доступ ко всем данным
      // навсегда. При этом тот же код служил резервной копией доступа, и
      // просто «сделать его одноразовым» было нельзя: люди сохраняют его
      // именно на случай потери телефона.
      //
      // Поэтому сценарии разведены. Резервная копия ключа осталась файлом,
      // который сохраняют осознанно, а сопряжение устройства идёт через
      // короткую встречу здесь: оба телефона кладут по одноразовому
      // публичному ключу, выводят общий секрет (ECDH) и передают им секреты
      // аккаунта. Сервер видит только шифротекст и два публичных ключа —
      // расшифровать не может.
      //
      // Записи живут пятнадцать минут и гаснут после первого получения:
      // перехваченный позже код бесполезен, потому что и встречи уже нет.
      if (url.pathname.startsWith('/pair/')) {
        const pairKey = (id) => `pair:${id}`;
        const readPair = async (id) => {
          if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
          const row = await env.DB.prepare('SELECT v FROM app_meta WHERE k = ?').bind(pairKey(id)).first();
          if (!row) return null;
          const rec = JSON.parse(row.v);
          if (rec.exp < Date.now()) {
            await env.DB.prepare('DELETE FROM app_meta WHERE k = ?').bind(pairKey(id)).run();
            return null;
          }
          return rec;
        };
        const writePair = (id, rec) =>
          env.DB.prepare('INSERT OR REPLACE INTO app_meta (k, v) VALUES (?, ?)')
            .bind(pairKey(id), JSON.stringify(rec))
            .run();

        // Устройство с аккаунтом открывает встречу и показывает QR.
        if (url.pathname === '/pair/offer' && request.method === 'POST') {
          const { pairId, pubA } = await request.json();
          if (!pairId || !pubA || !/^[A-Za-z0-9_-]{8,64}$/.test(pairId)) {
            return json({ error: 'bad request' }, 400, origin);
          }
          await writePair(pairId, { pubA, exp: Date.now() + PAIR_TTL_MS });
          return json({ ok: true }, 200, origin);
        }

        // Второе устройство отвечает своим одноразовым ключом. Первый ответ
        // побеждает: иначе кто-то, подсмотревший QR, мог бы перебить чужой
        // ответ и встать на место второго телефона.
        if (url.pathname === '/pair/answer' && request.method === 'POST') {
          const { pairId, pubB } = await request.json();
          const rec = await readPair(pairId);
          if (!rec) return json({ error: 'expired' }, 404, origin);
          if (rec.pubB) return json({ error: 'taken' }, 409, origin);
          if (!pubB) return json({ error: 'bad request' }, 400, origin);
          await writePair(pairId, { ...rec, pubB });
          return json({ ok: true, pubA: rec.pubA }, 200, origin);
        }

        // Первое устройство узнаёт, что ответ пришёл, и кладёт секреты,
        // зашифрованные общим секретом встречи.
        if (url.pathname === '/pair/state' && request.method === 'GET') {
          const rec = await readPair(url.searchParams.get('pairId'));
          if (!rec) return json({ error: 'expired' }, 404, origin);
          return json({ pubB: rec.pubB ?? null, sealed: Boolean(rec.sealed) }, 200, origin);
        }

        if (url.pathname === '/pair/seal' && request.method === 'POST') {
          const { pairId, sealed } = await request.json();
          const rec = await readPair(pairId);
          if (!rec) return json({ error: 'expired' }, 404, origin);
          if (!sealed) return json({ error: 'bad request' }, 400, origin);
          await writePair(pairId, { ...rec, sealed });
          return json({ ok: true }, 200, origin);
        }

        // Второе устройство забирает конверт — и запись исчезает.
        if (url.pathname === '/pair/claim' && request.method === 'GET') {
          const pairId = url.searchParams.get('pairId');
          const rec = await readPair(pairId);
          if (!rec?.sealed) return json({ sealed: null }, 200, origin);
          await env.DB.prepare('DELETE FROM app_meta WHERE k = ?').bind(pairKey(pairId)).run();
          return json({ sealed: rec.sealed }, 200, origin);
        }

        return json({ error: 'not found' }, 404, origin);
      }

      // Есть ли такой аккаунт — БЕЗ регистрации.
      //
      // authAccount доверяет первому обращению (trust on first use) и заводит
      // неизвестный accountId сам. Для обмена это правильно, а для
      // восстановления по ключу — ловушка: человек с верным ключом от аккаунта,
      // которого на сервере нет (сервер сменили, базу сбросили), видел
      // «Устройство подключено» и пустое приложение. Успех и полный провал
      // выглядели одинаково, и дальше он мог затереть облачную копию снимком
      // пустого телефона.
      if (url.pathname === '/account/check' && request.method === 'GET') {
        const accountId = request.headers.get('X-Account');
        const auth = request.headers.get('Authorization') || '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!accountId || !token) return json({ error: 'unauthorized' }, 401, origin);
        const row = await env.DB.prepare('SELECT token_hash FROM accounts WHERE account_id = ?')
          .bind(accountId)
          .first();
        if (!row) return json({ exists: false }, 200, origin);
        if (row.token_hash !== (await sha256hex(token)))
          return json({ error: 'unauthorized' }, 401, origin);
        const cnt = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM records WHERE account_id = ? AND deleted_at IS NULL',
        )
          .bind(accountId)
          .first();
        return json({ exists: true, records: Number(cnt?.n ?? 0) }, 200, origin);
      }

      if (url.pathname === '/sync/push' && request.method === 'POST') {
        const accountId = await authAccount(request, env);
        if (!accountId) return json({ error: 'unauthorized' }, 401, origin);
        const { records } = await request.json();
        if (!Array.isArray(records)) return json({ error: 'bad request' }, 400, origin);

        const stmt = env.DB.prepare(
          `INSERT INTO records (account_id, table_name, id, updated_at, deleted_at, ciphertext)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, table_name, id) DO UPDATE SET
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             ciphertext = excluded.ciphertext
           WHERE excluded.updated_at > records.updated_at`,
        );
        const batch = [];
        for (const r of records) {
          if (!r || typeof r.table !== 'string' || typeof r.id !== 'string') continue;
          if (typeof r.updatedAt !== 'string' || typeof r.ciphertext !== 'string') continue;
          batch.push(stmt.bind(accountId, r.table, r.id, r.updatedAt, r.deletedAt ?? null, r.ciphertext));
        }
        if (batch.length) await env.DB.batch(batch);
        return json({ ok: true, count: batch.length }, 200, origin);
      }

      if (url.pathname === '/sync/pull' && request.method === 'GET') {
        const accountId = await authAccount(request, env);
        if (!accountId) return json({ error: 'unauthorized' }, 401, origin);
        // Курсор СОСТАВНОЙ: "updatedAt|id" — сортировка идёт по (updated_at, id),
        // поэтому и продолжать надо по паре. С курсором только по updated_at
        // записи с одинаковым миллисекундным штампом, не поместившиеся на
        // страницу, терялись навсегда: следующий запрос просил строго больше
        // этого значения. Старый формат (без "|") понимаем как есть — тогда
        // id пустой и условие вырождается в прежнее поведение.
        const sinceRaw = url.searchParams.get('since') || '';
        const sep = sinceRaw.indexOf('|');
        const sinceU = sep >= 0 ? sinceRaw.slice(0, sep) : sinceRaw;
        const sinceId = sep >= 0 ? sinceRaw.slice(sep + 1) : '';
        // Сравнение row values, а НЕ эквивалентная форма с OR: только его
        // SQLite превращает в seek по составному индексу. С OR планировщик
        // берёт индекс лишь по account_id и сканирует все записи аккаунта на
        // каждый /sync/pull — при опросе раз в 60 с с двух устройств это
        // миллионы прочитанных строк в сутки и выход за лимиты D1.
        const res = await env.DB.prepare(
          `SELECT table_name AS tbl, id, updated_at AS u, deleted_at AS d, ciphertext AS c
           FROM records
           WHERE account_id = ? AND (updated_at, id) > (?, ?)
           ORDER BY updated_at, id LIMIT ?`,
        )
          .bind(accountId, sinceU, sinceId, PULL_LIMIT + 1)
          .all();
        const rows = res.results || [];
        let hasMore = rows.length > PULL_LIMIT;
        let page = hasMore ? rows.slice(0, PULL_LIMIT) : rows;
        // Режем по объёму, но всегда отдаём хотя бы одну запись: иначе
        // единственный кусок больше потолка встал бы намертво.
        let bytes = 0;
        for (let i = 0; i < page.length; i++) {
          bytes += (page[i].c || '').length;
          if (bytes > PULL_MAX_BYTES && i > 0) {
            page = page.slice(0, i);
            hasMore = true;
            break;
          }
        }
        const out = page.map((r) => ({
          table: r.tbl,
          id: r.id,
          updatedAt: r.u,
          deletedAt: r.d,
          ciphertext: r.c,
        }));
        const last = out.length ? out[out.length - 1] : null;
        const nextSince = last ? `${last.updatedAt}|${last.id}` : sinceRaw;
        return json({ records: out, hasMore, nextSince }, 200, origin);
      }

      // === Резервная копия аккаунта (E2E, только шифротекст) ===
      // Отдельно от /sync/*: снапшот — крупный блоб, не должен попадать в
      // дельта-поток синка. Модель latest-only: одна копия на аккаунт,
      // при необходимости разбита на чанки (лимит значения колонки D1 — 2 МБ).
      if (url.pathname === '/backup/put' && request.method === 'POST') {
        const accountId = await authAccount(request, env);
        if (!accountId) return json({ error: 'unauthorized' }, 401, origin);
        await ensureBackupTable(env);
        const { chunks, total, manifest } = await request.json();
        if (!Array.isArray(chunks) || typeof total !== 'number') {
          return json({ error: 'bad request' }, 400, origin);
        }
        const at = new Date().toISOString();
        // Удаляем «хвост» от прошлой, более длинной копии, затем перезаписываем.
        const batch = [
          env.DB.prepare('DELETE FROM backups WHERE account_id = ? AND chunk >= ?').bind(accountId, total),
        ];
        const put = env.DB.prepare(
          'INSERT OR REPLACE INTO backups (account_id, chunk, updated_at, ciphertext) VALUES (?, ?, ?, ?)',
        );
        for (const c of chunks) {
          if (!c || typeof c.chunk !== 'number' || typeof c.ciphertext !== 'string') continue;
          batch.push(put.bind(accountId, c.chunk, at, c.ciphertext));
        }
        // Манифест пишем в той же пачке: он обязан меняться вместе с копией,
        // иначе следующая проверка будет сверяться с чужими числами.
        if (typeof manifest === 'string' && manifest) {
          await ensureBackupMeta(env);
          batch.push(
            env.DB.prepare(
              `INSERT INTO backup_meta (account_id, manifest, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(account_id) DO UPDATE SET manifest = excluded.manifest, updated_at = excluded.updated_at`,
            ).bind(accountId, manifest, at),
          );
        }
        await env.DB.batch(batch);
        return json({ ok: true, at }, 200, origin);
      }

      // Только сведения о копии: когда обновлялась и из скольких кусков
      // состоит. Экран настроек показывает дату, и ради неё скачивал ВСЮ
      // копию целиком — на большой базе это мегабайты шифротекста на каждое
      // открытие настроек.
      if (url.pathname === '/backup/meta' && request.method === 'GET') {
        const accountId = await authAccount(request, env);
        if (!accountId) return json({ error: 'unauthorized' }, 401, origin);
        await ensureBackupTable(env);
        const row = await env.DB.prepare(
          'SELECT MAX(updated_at) AS u, COUNT(*) AS n FROM backups WHERE account_id = ?',
        )
          .bind(accountId)
          .first();
        const total = Number(row?.n ?? 0);
        await ensureBackupMeta(env);
        const meta = await env.DB.prepare(
          'SELECT manifest FROM backup_meta WHERE account_id = ?',
        )
          .bind(accountId)
          .first();
        return json(
          { updatedAt: total ? row.u : null, total, manifest: meta?.manifest ?? null },
          200,
          origin,
        );
      }

      if (url.pathname === '/backup/get' && request.method === 'GET') {
        const accountId = await authAccount(request, env);
        if (!accountId) return json({ error: 'unauthorized' }, 401, origin);
        await ensureBackupTable(env);
        const res = await env.DB.prepare(
          'SELECT chunk, updated_at AS u, ciphertext AS c FROM backups WHERE account_id = ? ORDER BY chunk',
        )
          .bind(accountId)
          .all();
        const rows = res.results || [];
        return json(
          {
            chunks: rows.map((r) => ({ chunk: r.chunk, ciphertext: r.c })),
            updatedAt: rows.length ? rows[0].u : null,
          },
          200,
          origin,
        );
      }

      // === Раздел ИИ: прокси к языковой модели ===
      // Два режима, различаются на клиенте по Content-Type ответа:
      //   - без ключа провайдера или model='echo' — заглушка, обычный JSON;
      //   - живой провайдер — passthrough SSE-потока байт в байт (§4.2 плана):
      //     JSON.parse каждой дельты здесь съедал бы CPU-лимит Workers Free
      //     (10 мс на инвокацию), ожидание I/O в лимит не входит.
      if (url.pathname === '/ai/chat' && request.method === 'POST') {
        const accountId = await authAccount(request, env);
        if (!accountId) return json({ error: 'unauthorized' }, 401, origin);
        // Allowlist — единственный барьер между публичным workers.dev и платным
        // ключом провайдера. Пустая переменная = пускать всех (режим отладки).
        const allowed = (env.AI_ALLOWED_ACCOUNTS || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (allowed.length && !allowed.includes(accountId)) {
          return json({ error: 'forbidden', message: 'аккаунт не в списке разрешённых' }, 403, origin);
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: 'bad_request', message: 'тело не JSON' }, 400, origin);
        }
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        // Пересборка в чистые объекты: наружу уходят только известные поля.
        // Кроме user/assistant-текста тут ходят участники tool use (этап 3):
        // ответ модели с tool_calls и результат инструмента (role: 'tool') —
        // без них follow-up запрос цикла не свяжется с вызовом.
        const clean = [];
        for (const m of messages) {
          if (!m || typeof m !== 'object') continue;
          if (m.role === 'tool' && typeof m.tool_call_id === 'string' && typeof m.content === 'string') {
            clean.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
          } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            const calls = m.tool_calls
              .filter((c) => c && typeof c.id === 'string' && c.function
                && typeof c.function.name === 'string' && typeof c.function.arguments === 'string')
              .map((c) => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } }));
            if (calls.length) {
              clean.push({ role: 'assistant', content: typeof m.content === 'string' && m.content ? m.content : null, tool_calls: calls });
            }
          } else if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()) {
            clean.push({ role: m.role, content: m.content });
          }
        }
        // Хотя бы одна обычная реплика: история из одних служебных сообщений —
        // признак сломанного клиента, провайдеру такое не шлём.
        if (!clean.some((m) => m.role === 'user')) {
          return json({ error: 'bad_request', message: 'нет сообщений' }, 400, origin);
        }
        // Определения инструментов пробрасываются как есть: их состав — дело
        // клиента, воркер не знает и не должен знать, что у модели за руки.
        const tools = Array.isArray(body?.tools) && body.tools.length ? body.tools : undefined;

        const model = typeof body?.model === 'string' ? body.model : 'echo';
        if (model === 'echo' || !env.AI_PROVIDER_KEY) {
          return json(echoReply(clean, body?.systemPrompt), 200, origin);
        }

        // Живой провайдер. Формат — OpenAI chat completions (его говорят все
        // агрегаторы; для Polza сверяется при настройке). Адрес НЕ зашит:
        // AI_PROVIDER_URL — полный URL эндпоинта completions в переменных
        // воркера, менять провайдера можно без правки кода.
        if (!env.AI_PROVIDER_URL) {
          return json({ error: 'provider', message: 'AI_PROVIDER_URL не настроен' }, 500, origin);
        }
        const sys = typeof body?.systemPrompt === 'string' && body.systemPrompt.trim()
          ? [{ role: 'system', content: body.systemPrompt }]
          : [];
        let upstream;
        try {
          upstream = await fetch(env.AI_PROVIDER_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.AI_PROVIDER_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              messages: [...sys, ...clean],
              stream: true,
              // usage приходит финальным чанком — иначе стоимость не посчитать.
              stream_options: { include_usage: true },
              // Общий потолок на размышления И текст (§4.5): с дефолтными 4096
              // ответы регулярно рвались бы посреди генерации.
              max_tokens: 32000,
              ...(tools ? { tools } : {}),
            }),
          });
        } catch {
          return json({ error: 'provider', message: 'провайдер недоступен' }, 502, origin);
        }
        if (!upstream.ok) {
          // Тело ошибки провайдера отдаём как есть (без ключей там ничего нет),
          // статус пробрасываем — клиент различает 401/403/429 по нему.
          const text = await upstream.text().catch(() => '');
          return json({ error: 'provider', message: text.slice(0, 500) || `HTTP ${upstream.status}` }, upstream.status, origin);
        }
        return new Response(upstream.body, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            ...corsHeaders(origin),
          },
        });
      }

      // === Семья: проксируем в Durable Object (1 комната на семью) ===
      if (url.pathname.startsWith('/family/')) {
        const familyId = url.searchParams.get('familyId') || request.headers.get('X-Account');
        if (!familyId) return json({ error: 'no family' }, 400, origin);
        const stub = env.FAMILY_ROOM.get(env.FAMILY_ROOM.idFromName(familyId));
        const res = await stub.fetch(request);
        if (res.webSocket) return res; // WS upgrade — отдаём как есть
        const h = new Headers(res.headers);
        for (const [k, v] of Object.entries(corsHeaders(origin))) h.set(k, v);
        return new Response(res.body, { status: res.status, headers: h });
      }

      return json({ error: 'not found' }, 404, origin);
    } catch (e) {
      return json({ error: String(e) }, 500, origin);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sendDue(env));
    ctx.waitUntil(checkAppVersion(env)); // сторож версии → авто-пуш об обновлении
  },
};

/**
 * Заглушка вместо языковой модели. Отвечает разметкой, чтобы на клиенте сразу
 * было видно рендер markdown, и отдаёт usage в том же виде, в каком его отдаст
 * настоящий провайдер, — тогда подключение живого адаптера не потребует правок
 * ни в клиенте, ни в схеме данных.
 *
 * Оценка токенов грубая (символы / 3). Для русского это ЗАНИЖЕНИЕ: RU-текст
 * токенизируется дороже английского. Точное число придёт от провайдера вместе
 * с ответом, поэтому на этой эвристике ничего важного строить нельзя.
 */
function echoReply(messages, systemPrompt) {
  const last = messages[messages.length - 1];
  const inChars = messages.reduce((n, m) => n + m.content.length, 0) + (systemPrompt || '').length;
  const content = [
    '**Заглушка-эхо.** Провайдер пока не подключён — отвечает воркер.',
    '',
    'Ваш вопрос:',
    '',
    `> ${last.content.slice(0, 500).replace(/\n/g, '\n> ')}`,
    '',
    `Сообщений в контексте: ${messages.length}${systemPrompt ? ' · системный промпт задан' : ''}`,
    '',
    '```js',
    "// проверка подсветки блока кода",
    "const ok = true;",
    '```',
  ].join('\n');
  return {
    content,
    model: 'echo',
    usage: { in: Math.ceil(inChars / 3), out: Math.ceil(content.length / 3) },
  };
}

// Текст по умолчанию для рассылки об обновлении. Кнопки «Обновить» в
// приложении НЕТ: service worker ставит новую версию сам и перезагружает
// страницу. Прежний текст «нажмите «Обновить»» отправлял человека искать то,
// чего не существует, — а прилетает он автоматически, кроном раз в минуту,
// как только меняется хэш бандла на GitHub Pages.
const DEFAULT_UPDATE_TEXT = 'Приложение обновилось — откройте, чтобы посмотреть, что нового';
const APP_INDEX_URL = 'https://xabos02.github.io/life-hub/index.html';

/** Разослать пуш «вышло обновление» всем подписчикам. Возвращает число доставок. */
async function broadcastUpdate(env, bodyText) {
  const vapid = {
    publicKey: env.VAPID_PUBLIC,
    privateKey: env.VAPID_PRIVATE,
    subject: env.VAPID_SUBJECT || 'mailto:noreply@life-hub.app',
  };
  if (!vapid.privateKey) return 0;
  const subs = await env.DB.prepare('SELECT endpoint, sub FROM push_subs').all();
  let sent = 0;
  for (const r of subs.results || []) {
    try {
      const { endpoint, headers, body } = await buildPushRequest({
        subscription: JSON.parse(r.sub),
        payload: JSON.stringify({ title: '✨ Доступно обновление', body: bodyText, url: '/life-hub/', tag: 'app-update' }),
        vapid,
        ttl: 86400,
        urgency: 'normal',
      });
      const res = await fetch(endpoint, { method: 'POST', headers, body });
      if (res.ok) sent++;
      else if (res.status === 404 || res.status === 410) {
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(r.endpoint).run();
      }
    } catch {
      /* мёртвая подписка — пропускаем */
    }
  }
  return sent;
}

/** Cron-сторож версии: при каждом новом деплое (сменился хэш JS-бандла в
 *  index.html живого сайта) — авто-рассылка пуша об обновлении. Первое
 *  наблюдение лишь запоминает версию, не уведомляя. */
async function checkAppVersion(env) {
  try {
    const res = await fetch(`${APP_INDEX_URL}?_=${Date.now()}`, {
      headers: { 'cache-control': 'no-cache' },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!res.ok) return;
    const html = await res.text();
    const m = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
    if (!m) return;
    const version = m[0];
    const row = await env.DB.prepare('SELECT v FROM app_meta WHERE k = ?').bind('app_version').first();
    const prev = row ? row.v : null;
    if (prev === version) return; // версия не менялась
    await env.DB.prepare('INSERT OR REPLACE INTO app_meta (k, v) VALUES (?, ?)').bind('app_version', version).run();
    if (prev === null) return; // первое наблюдение — не уведомляем
    await broadcastUpdate(env, DEFAULT_UPDATE_TEXT);
  } catch {
    /* транзиентная ошибка — попробуем на следующем тике cron */
  }
}

async function sendDue(env) {
  const vapid = {
    publicKey: env.VAPID_PUBLIC,
    privateKey: env.VAPID_PRIVATE,
    subject: env.VAPID_SUBJECT || 'mailto:noreply@life-hub.app',
  };
  // Запас 30с (cron раз в минуту). Один SELECT по индексу fire_at вместо
  // KV list — D1-чтения практически безлимитны на free-тарифе.
  const due = await env.DB.prepare('SELECT task_id, fire_at, title, body, subscription FROM reminders WHERE fire_at <= ?')
    .bind(Date.now() + 30_000)
    .all();
  for (const r of due.results || []) {
    try {
      const { endpoint, headers, body } = await buildPushRequest({
        subscription: JSON.parse(r.subscription),
        payload: JSON.stringify({ title: r.title || 'Напоминание', body: r.body || '', taskId: r.task_id }),
        vapid,
        ttl: 3600,
        urgency: 'high',
      });
      const res = await fetch(endpoint, { method: 'POST', headers, body });
      console.log(`push ${r.task_id}: ${res.status}`);
    } catch (e) {
      console.log(`push ${r.task_id} error: ${String(e)}`);
    }
    // снимаем в любом случае — напоминание одноразовое (404/410 = подписка мертва)
    await env.DB.prepare('DELETE FROM reminders WHERE task_id = ?').bind(r.task_id).run();
  }
}
