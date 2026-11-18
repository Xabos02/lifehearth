// ВРЕМЕННЫЙ проверочный скрипт Workers AI — не для main.
// Репозиторий публичный: из настроек воркера печатаются только имена и типы.
const ACC = process.env.CF_ACCOUNT_ID;
const TOK = process.env.CF_API_TOKEN;
const MODE = process.env.PROBE_MODE || 'all';
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACC}`;
const PROBE_URL = process.env.PROBE_URL;
const PROBE_KEY = process.env.PROBE_KEY;
const H = { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' };
const PRICE = {
  '@cf/openai/gpt-oss-120b': [31818, 68182],
  '@cf/openai/gpt-oss-20b': [18182, 27273],
  '@cf/nvidia/nemotron-3-120b-a12b': [45455, 136364],
  '@cf/google/gemma-4-26b-a4b-it': [9091, 27273],
  '@cf/qwen/qwen3.8-27b': [40909, 290909],
};
// Qwen по умолчанию думает на xhigh, а выход у него в 10 раз дороже Gemma:
// гоняем с короткими размышлениями и на части вопросов, чтобы не съесть лимит дня.
// 18.11: ищем замену Qwen 3.8 с длинным ответом — 5 вопросов на модель, чтобы не съесть дневной лимит.
const EXTRA = { '@cf/qwen/qwen3.8-27b': { reasoning_effort: 'low' } };
// Gemma и Qwen 3.8 — только проверка, что пустая строка вместо null в content проходит.
const NO_QUALITY = new Set(['@cf/google/gemma-4-26b-a4b-it', '@cf/qwen/qwen3.8-27b']);
const ALL_SUBSET = [0, 1, 4, 5, 7];
const SUBSET = {};
const MAXT = { '@cf/openai/gpt-oss-120b': 16384, '@cf/openai/gpt-oss-20b': 16384, '@cf/nvidia/nemotron-3-120b-a12b': 16384 };
const MODELS = Object.keys(PRICE);
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 8192);
const log = (...a) => console.log(...a);
const cut = (s, n = 300) => (s && s.length > n ? s.slice(0, n) + '…' : s);
const neurons = (m, u) => (u ? (u.prompt_tokens * PRICE[m][0] + u.completion_tokens * PRICE[m][1]) / 1e6 : null);

const TODAY = '2026-11-18';
const SYS_TOOLS = [
  `Сегодня ${TODAY}.`,
  'Тебе доступны инструменты чтения данных пользователя из его органайзера LifeHearth:',
  'задачи, заметки, финансы, привычки, цели, обучение, уровень энергии.',
  'Раздел «Женские дни» тебе недоступен — если спросят о цикле, прямо скажи, что ассистент его не читает.',
  'Когда вопрос касается личных данных или планов — сначала прочитай их инструментом, потом отвечай по фактам.',
  'Не выдумывай записи, которых нет. Отвечай на языке пользователя, кратко и по делу.',
].join(' ');
const SYS_NODATA = [
  'Ты — ассистент органайзера LifeHearth. Доступа к записям пользователя в этом чате нет.',
  'На вопросы о его задачах, заметках, финансах и привычках отвечай, что для этого нужно включить «Данные» под полем ввода.',
  'Прежние ответы в истории чата — не текущие данные.',
].join(' ');

const fn = (name, description, properties = {}, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, ...(required ? { required } : {}) } },
});
const TOOL_DEFS = [
  fn('list_tasks', 'Задачи пользователя с проектами, сроками и приоритетами. По умолчанию активные; status=completed — выполненные, all — все.', {
    status: { type: 'string', enum: ['active', 'completed', 'all'] },
    from: { type: 'string', description: 'начало окна по сроку, YYYY-MM-DD' },
    to: { type: 'string', description: 'конец окна по сроку, YYYY-MM-DD' },
  }),
  fn('search_notes', 'Поиск по заметкам (заголовок и текст). Возвращает заголовки и фрагменты.', { query: { type: 'string', description: 'что искать' } }, ['query']),
  fn('read_note', 'Полный текст одной заметки по заголовку (точному или частичному).', { title: { type: 'string' } }, ['title']),
  fn('list_finance', 'Финансы: регулярные расходы и доходы с месячной сводкой, цели-копилки с накопленным.'),
  fn('list_habits', 'Привычки с расписанием и выполнением за последние 7 и 28 дней.'),
  fn('list_goals', 'Цели с прогрессом и сроками.'),
  fn('list_learning', 'Обучение: книги, курсы и прочее с прогрессом.'),
  fn('energy_summary', 'Уровень сил по дням за последние 28 дней (шкала 1–5) со средними.'),
];

// Подставные данные в формате настоящих инструментов (tools.ts).
const TASKS = [
  { title: 'Оплатить интернет', due: '2026-11-17', priority: 'medium', repeat: 'ежемесячно' },
  { title: 'Сдать эссе по стратегии (MBA)', project: 'Учёба', due: '2026-11-18', priority: 'high', checklist: '1/3' },
  { title: 'Позвонить в банк про карту', due: '2026-11-19' },
  { title: 'Купить подарок маме', project: 'Семья', due: '2026-11-21', priority: 'medium', notes: 'ей нравятся книги и чай' },
  { title: 'Записаться к стоматологу', priority: 'low' },
  { title: 'Разобрать гардероб', due: '2026-11-29' },
];
function runTool(name, argsJson) {
  let a = {};
  try { a = JSON.parse(argsJson || '{}') || {}; } catch {}
  switch (name) {
    case 'list_tasks': {
      let rows = TASKS;
      if (a.from || a.to) rows = rows.filter((t) => t.due && (!a.from || t.due >= a.from) && (!a.to || t.due <= a.to));
      return JSON.stringify({ today: TODAY, tasks: rows });
    }
    case 'search_notes':
      return /отпуск|калинингр|поездк/i.test(String(a.query))
        ? JSON.stringify({ notes: [{ title: 'Отпуск в Калининграде', snippet: 'Даты: 12–19 июня. Бюджет 80 000 ₽…' }] })
        : JSON.stringify({ notes: [] });
    case 'read_note':
      return /калинингр|отпуск/i.test(String(a.title))
        ? JSON.stringify({ title: 'Отпуск в Калининграде', text: 'Даты: 12–19 июня. Бюджет 80 000 ₽ на двоих. Билеты взять до 1 марта — потом дорожают. Жильё: Зеленоградск, 3 ночи, потом Светлогорск. Хочу: Куршская коса, музей янтаря, рыбная деревня. Не забыть: загранпаспорт не нужен, но взять паспорт РФ.' })
        : JSON.stringify({ error: 'заметка не найдена' });
    case 'list_finance':
      return JSON.stringify({
        items: [
          { title: 'Аренда', kind: 'expense', amount: 45000, period: 'monthly' },
          { title: 'Интернет', kind: 'expense', amount: 800, period: 'monthly' },
          { title: 'Спортзал', kind: 'expense', amount: 3500, period: 'monthly' },
          { title: 'Подписки', kind: 'expense', amount: 1200, period: 'monthly' },
          { title: 'Зарплата', kind: 'income', amount: 95000, period: 'monthly' },
        ],
        monthlyExpense: 50500,
        monthlyIncome: 95000,
        savings: [{ title: 'Подушка', target: 300000, saved: 120000, due: '2027-06-01' }],
      });
    case 'list_habits':
      return JSON.stringify({ today: TODAY, habits: [
        { title: 'Зарядка', schedule: 'ежедневно', done7: 3, done28: 15 },
        { title: 'Чтение 20 минут', schedule: 'ежедневно', done7: 6, done28: 24 },
        { title: 'Без сахара', schedule: '5 раз в неделю', done7: 2, done28: 13 },
      ] });
    case 'list_goals':
      return JSON.stringify({ goals: [{ title: 'Закрыть MBA', progress: 60, due: '2027-06-30' }] });
    case 'list_learning':
      return JSON.stringify({ items: [{ title: 'Хороший стратег — Ричард Румельт', type: 'книга', progress: '120/320' }] });
    case 'energy_summary':
      return JSON.stringify({ days: [
        { date: '2026-11-10', level: 4 }, { date: '2026-11-11', level: 3 }, { date: '2026-11-12', level: 2 },
        { date: '2026-11-13', level: 2 }, { date: '2026-11-14', level: 3 }, { date: '2026-11-15', level: 4 },
      ], avg7: 3.0, avg28: 3.4 });
    default:
      return JSON.stringify({ error: 'нет такого инструмента' });
  }
}

// Разбор SSE: копия логики openaiStream.ts (что увидит клиент) + учёт чужих форм.
function parseSSE(raw) {
  const st = { content: '', reasoning: 0, toolCalls: [], finish: null, usage: null, done: false, error: null, shapes: new Set(), deltaKeys: new Set(), native: '' };
  for (const line0 of raw.split('\n')) {
    const line = line0.replace(/\r$/, '');
    if (!line.startsWith('data:')) { if (line.trim()) st.shapes.add('NONDATA:' + cut(line, 80)); continue; }
    const p = line.slice(5).trim();
    if (!p) continue;
    if (p === '[DONE]') { st.done = true; continue; }
    let o;
    try { o = JSON.parse(p); } catch { st.shapes.add('BADJSON'); continue; }
    st.shapes.add(Object.keys(o).sort().join(','));
    if (o.error) st.error = JSON.stringify(o.error);
    if (typeof o.response === 'string') st.native += o.response;
    const ch = o.choices?.[0];
    if (ch?.delta) {
      for (const k of Object.keys(ch.delta)) st.deltaKeys.add(k);
      if (typeof ch.delta.content === 'string') st.content += ch.delta.content;
      for (const k of ['reasoning_content', 'reasoning']) if (typeof ch.delta[k] === 'string') st.reasoning += ch.delta[k].length;
      for (const tc of ch.delta.tool_calls ?? []) {
        const i = typeof tc.index === 'number' ? tc.index : 0;
        while (st.toolCalls.length <= i) st.toolCalls.push({ id: '', name: '', arguments: '' });
        const s = st.toolCalls[i];
        if (tc.id) s.id = tc.id;
        if (tc.function?.name) s.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') s.arguments += tc.function.arguments;
      }
    }
    if (ch?.finish_reason) st.finish = ch.finish_reason;
    if (o.usage) st.usage = o.usage;
  }
  return st;
}

async function call(endpoint, model, messages, tools, maxTokens = MAX_TOKENS) {
  const input = { messages, stream: true, stream_options: { include_usage: true }, max_tokens: MAXT[model] && maxTokens === MAX_TOKENS ? MAXT[model] : maxTokens, ...(tools ? { tools } : {}), ...(EXTRA[model] ?? {}) };
  const t0 = Date.now();
  let r;
  for (let i = 0; i < 20; i++) {
    r = await fetch(`${PROBE_URL}/?k=${PROBE_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input }) });
    // workers.dev нового воркера разъезжается по сети несколько секунд
    if (r.status !== 404 && r.status !== 403 && r.status !== 530) break;
    await new Promise((res) => setTimeout(res, 3000));
  }
  const raw = await r.text();
  return { status: r.status, ct: r.headers.get('content-type'), raw, ms: Date.now() - t0 };
}

async function errors() {
  log('\n## 2b. Форма ошибок binding');
  const bad = await call('binding', '@cf/nope/not-a-model', [{ role: 'user', content: 'hi' }]);
  log('bad model:', bad.status, cut(bad.raw, 400));
  const big = await call('binding', MODELS[0], [{ role: 'user', content: 'hi' }], undefined, 10_000_000);
  log('huge max_tokens:', big.status, cut(big.raw, 400));
  const m32 = await call('binding', MODELS[0], [{ role: 'user', content: 'Ответь одним словом: да' }], undefined, 32000);
  log('max_tokens 32000:', m32.status, cut(m32.raw.split('\n').filter(Boolean).slice(-3).join(' / '), 400));
}

function report(tag, model, res) {
  const lines = res.raw.split('\n').filter((l) => l.trim());
  log(`--- ${tag}: HTTP ${res.status} ct=${res.ct} ${res.ms}ms lines=${lines.length}`);
  if (res.status !== 200) { log('  body:', cut(res.raw, 800)); return null; }
  for (const l of lines.slice(0, 5)) log('  first>', cut(l, 260));
  for (const l of lines.slice(-3)) log('  last >', cut(l, 260));
  const st = parseSSE(res.raw);
  log('  shapes:', [...st.shapes].join(' | '));
  log('  delta keys:', [...st.deltaKeys].join(','), 'reasoningChars:', st.reasoning, 'native(response) chars:', st.native.length);
  log('  content:', JSON.stringify(cut(st.content, 400)));
  log('  toolCalls:', JSON.stringify(st.toolCalls));
  log('  finish:', st.finish, 'done:', st.done, 'usage:', JSON.stringify(st.usage), 'neurons≈', neurons(model, st.usage)?.toFixed(1), 'error:', st.error);
  const clientOk = !st.error && (st.content || st.toolCalls.some((c) => c.id && c.name));
  log('  CLIENT PARSER OK:', Boolean(clientOk));
  return st;
}

async function settings() {
  log('## 1. Настройки воркера life-hub-push (имена и типы)');
  const r = await fetch(`${BASE}/workers/scripts/life-hub-push/settings`, { headers: H });
  const j = await r.json().catch(() => ({}));
  log('settings HTTP', r.status, 'success', j.success, (j.errors || []).map((e) => `${e.code}:${e.message}`).join('; '));
  for (const b of j.result?.bindings ?? []) {
    let extra = '';
    if (/^AI_/.test(b.name) && b.type === 'plain_text') extra = ` (plain, entries=${String(b.text || '').split(',').filter((s) => s.trim()).length})`;
    log(`  ${b.name} : ${b.type}${extra}`);
  }
  const s2 = await fetch(`${BASE}/workers/scripts/life-hub-push/secrets`, { headers: H });
  const j2 = await s2.json().catch(() => ({}));
  log('secrets HTTP', s2.status, 'names:', (j2.result || []).map((x) => x.name).join(', '));
}

async function probe() {
  log('\n## 2. Проверочный запрос: tools + stream + max_tokens', MAX_TOKENS);
  const msgs = [{ role: 'system', content: SYS_TOOLS }, { role: 'user', content: 'Что у меня по задачам на этой неделе? Что самое срочное?' }];
  const ok = {};
  for (const model of MODELS) {
    for (const ep of ['binding']) {
      const tag = `${model} via ${ep}`;
      const r1 = await call(ep, model, msgs, TOOL_DEFS);
      const st = report(`${tag} R1`, model, r1);
      const calls = st?.toolCalls.filter((c) => c.id && c.name) ?? [];
      if (!calls.length) { ok[tag] = false; continue; }
      const wire = [...msgs, { role: 'assistant', content: st.content || '', tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }];
      for (const c of calls) wire.push({ role: 'tool', tool_call_id: c.id, content: runTool(c.name, c.arguments) });
      const r2 = await call(ep, model, wire, TOOL_DEFS);
      const st2 = report(`${tag} R2`, model, r2);
      ok[tag] = Boolean(st2 && st2.content && !st2.error);
    }
  }
  log('\nИТОГ ПРОВЕРКИ:', JSON.stringify(ok));
  return ok;
}

const QUESTIONS = [
  { data: false, q: 'Объясни простыми словами, что такое сложный процент, и посчитай: 100 000 ₽ под 15% годовых с ежегодной капитализацией на 3 года.' },
  { data: false, q: 'Составь план тренировок на неделю для новичка: 3 дня, без зала, по 30 минут.' },
  { data: false, q: 'Напиши короткое вежливое сообщение арендодателю, что оплата задержится на 3 дня.' },
  { data: false, q: 'Сколько у меня задач на завтра?' },
  { data: true, q: 'Что у меня на этой неделе по задачам? Что самое срочное?' },
  { data: true, q: 'Сколько я трачу в месяц и когда при таком темпе накоплю «Подушку», если откладывать половину остатка?' },
  { data: true, q: 'Как у меня с привычками за последнюю неделю? Что проседает?' },
  { data: true, q: 'Найди мою заметку про отпуск и коротко перескажи, что нужно сделать заранее.' },
  { data: true, q: 'Какой у меня был уровень энергии последние дни? Есть связь с задачами?' },
  { data: true, q: 'Что у меня с циклом в этом месяце?' },
];

async function agent(ep, model, item) {
  const wire = [{ role: 'system', content: item.data ? SYS_TOOLS : SYS_NODATA }, { role: 'user', content: item.q }];
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const trace = [];
  let text = '';
  let ms = 0;
  let finish = null;
  for (let round = 0; round <= 4; round++) {
    const r = await call(ep, model, wire, item.data ? TOOL_DEFS : undefined);
    ms += r.ms;
    if (r.status !== 200) return { error: `HTTP ${r.status} ${cut(r.raw, 300)}`, trace, usage, ms };
    const st = parseSSE(r.raw);
    if (st.error) return { error: st.error, trace, usage, ms };
    if (st.usage) { usage.prompt_tokens += st.usage.prompt_tokens || 0; usage.completion_tokens += st.usage.completion_tokens || 0; }
    finish = st.finish;
    if (st.content.trim()) text += (text ? '\n\n' : '') + st.content;
    const calls = item.data ? st.toolCalls.filter((c) => c.id && c.name) : [];
    if (!calls.length) break;
    wire.push({ role: 'assistant', content: st.content || '', tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) });
    for (const c of calls) { trace.push(`${c.name}(${c.arguments})`); wire.push({ role: 'tool', tool_call_id: c.id, content: runTool(c.name, c.arguments) }); }
  }
  return { text, trace, usage, ms, finish };
}

async function quality(ep, model) {
  log(`\n## 3. Качество: ${model} via ${ep}`);
  let total = 0;
  for (const [i, item] of QUESTIONS.entries()) {
    if (!(SUBSET[model] ?? ALL_SUBSET).includes(i)) continue;
    const r = await agent(ep, model, item);
    const n = neurons(model, r.usage);
    total += n || 0;
    log(`\n### Q${i + 1} [${item.data ? 'данные' : 'без данных'}] ${item.q}`);
    log(`tools: ${r.trace.join(' → ') || '—'} | tokens in/out ${r.usage.prompt_tokens}/${r.usage.completion_tokens} | neurons≈${n?.toFixed(1)} | ${r.ms}ms | finish ${r.finish}`);
    log(r.error ? `ОШИБКА: ${r.error}` : cut(r.text, 1800));
  }
  const n = (SUBSET[model] ?? ALL_SUBSET).length;
  log(`\nВсего neurons≈${total.toFixed(0)} на ${n} вопросов (${(total / n).toFixed(1)} в среднем)`);
}

// настройки прод-воркера 18.11 не нужны
let ok = {};
if (MODE === 'all' || MODE === 'probe') { ok = await probe(); }
if (MODE === 'all' || MODE === 'quality') {
  for (const model of MODELS) {
    const ep = ok[`${model} via binding`] || MODE === 'quality' ? 'binding' : null;
    if (NO_QUALITY.has(model)) continue;
    if (ep) await quality(ep, model);
    else log(`\n## 3. ${model}: проверка не прошла, качество не гоняю`);
  }
}
