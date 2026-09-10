// Инструменты доступа модели к данным пользователя (этап 3 плана, §6).
//
// Только чтение. Модель просит инструмент через tool use (формат OpenAI),
// исполняем здесь — на устройстве, поверх Dexie. В сеть уходит РЕЗУЛЬТАТ
// вызова (компактный JSON), поэтому объём каждого ответа ограничен: полная
// выгрузка раздела в контекст — это и деньги за токены, и потолок окна.
//
// Семья в инструменты не входит: переписка — не только твои данные.
// «Женские дни» входят по явному решению владельца (17.08), с двумя
// оговорками: замок раздела (код доступа) закрывает и доступ ИИ — фоновая
// выдача в API не должна обходить PIN; интимный слой (в типах прямо помечен
// как специальная категория 152-ФЗ) не отдаётся никогда — для ответов о
// цикле он не нужен.

import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { monthlyAmount } from '../finance';
import type { Habit, LearningItem, Task } from '../../db/types';

/** След вызова для интерфейса: что читали и сколько нашли.
 *  Храним машинно (имя + число), подпись рендерится на языке зрителя. */
export interface ToolTraceEntry {
  tool: string;
  count: number;
}

/** Определения в wire-формате OpenAI — уходят в поле tools запроса. */
export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description:
        'Задачи пользователя с проектами, сроками и приоритетами. По умолчанию активные; status=completed — выполненные, all — все.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'completed', 'all'] },
          from: { type: 'string', description: 'начало окна по сроку, YYYY-MM-DD' },
          to: { type: 'string', description: 'конец окна по сроку, YYYY-MM-DD' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: 'Поиск по заметкам (заголовок и текст). Возвращает заголовки и фрагменты.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'что искать' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: 'Полный текст одной заметки по заголовку (точному или частичному).',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_finance',
      description:
        'Финансы: регулярные расходы и доходы с месячной сводкой, цели-копилки с накопленным.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_habits',
      description: 'Привычки с расписанием и выполнением за последние 7 и 28 дней.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_goals',
      description: 'Цели с прогрессом и сроками.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_learning',
      description: 'Обучение: книги, курсы и прочее с прогрессом.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'energy_summary',
      description: 'Уровень сил по дням за последние 28 дней (шкала 1–5) со средними.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cycle_summary',
      description:
        'Женские дни: день и фаза текущего цикла, длины прошлых циклов, прогноз следующего, отметки за 35 дней (кровотечение, симптомы, БТТ).',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/** Русские подписи инструментов — для чипов следа и строки «читаю…».
 *  Ключи совпадают с function.name; подпись прогоняется через t() в UI. */
export const TOOL_LABELS: Record<string, string> = {
  list_tasks: 'Задачи',
  search_notes: 'Поиск заметок',
  read_note: 'Заметка',
  list_finance: 'Финансы',
  list_habits: 'Привычки',
  list_goals: 'Цели',
  list_learning: 'Обучение',
  energy_summary: 'Энергия',
  cycle_summary: 'Женские дни',
};

// Потолки объёма ответа. Не конфигурируются: это защита контекста и кошелька,
// а не настройка. При усечении модель узнаёт об этом из поля truncated.
const MAX_TASKS = 300;
const MAX_NOTES = 30;
const NOTE_CHARS = 6000;
const SNIPPET_CHARS = 140;

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const dayKeyShift = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** HTML заметки → простой текст. В браузере — DOM-парсер, как в поиске и
 *  списке заметок; в юнитах (node, DOMParser отсутствует) — стрип тегов.
 *  Для поиска и передачи модели такой точности достаточно. */
function htmlToText(html: string | null | undefined): string {
  const src = html ?? ''; // запись без content приезжает синком со старой версии
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(src, 'text/html');
    return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
  return src
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function recurrenceLabel(r: Task['recurrence']): string | undefined {
  if (!r) return undefined;
  switch (r.type) {
    case 'daily':
      return r.interval === 1 ? 'ежедневно' : `каждые ${r.interval} дн`;
    case 'weekly':
      return 'еженедельно';
    case 'monthly':
      return 'ежемесячно';
    case 'yearly':
      return 'ежегодно';
  }
}

function scheduleLabel(s: Habit['schedule']): string {
  switch (s.type) {
    case 'daily':
      return 'ежедневно';
    case 'weekdays':
      return `дни недели: ${s.weekdays.join(',')}`;
    case 'timesPerWeek':
      return `${s.times} раз в неделю`;
  }
}

interface ToolResult {
  /** JSON-строка — содержимое tool-сообщения для модели. */
  text: string;
  count: number;
}

async function runListTasks(args: Record<string, unknown>): Promise<ToolResult> {
  const status = args.status === 'completed' || args.status === 'all' ? args.status : 'active';
  const from = typeof args.from === 'string' ? args.from : null;
  const to = typeof args.to === 'string' ? args.to : null;

  const [tasks, projects] = await Promise.all([
    alive(await db.tasks.toArray()),
    alive(await db.projects.toArray()),
  ]);
  const projName = new Map(projects.map((p) => [p.id, p.name]));

  let rows = tasks.filter((t) =>
    status === 'all' ? true : status === 'completed' ? !!t.completedAt : !t.completedAt,
  );
  // Окно по сроку. Задачи без даты отдаём только когда окно не задано:
  // «что у меня на этой неделе» не должно тащить весь бэклог.
  if (from || to) {
    rows = rows.filter((t) => t.dueDate && (!from || t.dueDate >= from) && (!to || t.dueDate <= to));
  }
  rows.sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));

  const truncated = rows.length > MAX_TASKS;
  const out = rows.slice(0, MAX_TASKS).map((t) => ({
    title: t.title,
    project: t.projectId ? projName.get(t.projectId) : undefined,
    due: t.dueDate ?? undefined,
    start: t.startDate ?? undefined,
    time: t.dueTime ?? undefined,
    priority: (['', 'low', 'medium', 'high'] as const)[t.priority] || undefined,
    tags: t.tags.length ? t.tags : undefined,
    repeat: recurrenceLabel(t.recurrence),
    checklist: t.checklist.length
      ? `${t.checklist.filter((c) => c.done).length}/${t.checklist.length}`
      : undefined,
    frozen: t.frozenAt ? true : undefined,
    completedAt: t.completedAt ? t.completedAt.slice(0, 10) : undefined,
    notes: t.notes.trim() ? t.notes.slice(0, SNIPPET_CHARS) : undefined,
  }));
  return {
    text: JSON.stringify({ today: todayKey(), tasks: out, ...(truncated ? { truncated: true } : {}) }),
    count: out.length,
  };
}

async function runSearchNotes(args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  if (!query) return { text: JSON.stringify({ error: 'пустой запрос' }), count: 0 };
  const [notes, folders] = await Promise.all([
    alive(await db.notes.toArray()),
    alive(await db.noteFolders.toArray()),
  ]);
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  const hits = [];
  for (const n of notes) {
    const text = htmlToText(n.content);
    const inTitle = n.title.toLowerCase().includes(query);
    const at = text.toLowerCase().indexOf(query);
    if (!inTitle && at < 0) continue;
    const snippet =
      at < 0 ? text.slice(0, SNIPPET_CHARS) : text.slice(Math.max(0, at - 40), at + SNIPPET_CHARS - 40);
    hits.push({
      title: n.title || '(без названия)',
      folder: n.folderId ? folderName.get(n.folderId) : undefined,
      pinned: n.pinned || undefined,
      snippet,
    });
    if (hits.length >= MAX_NOTES) break;
  }
  return { text: JSON.stringify({ notes: hits }), count: hits.length };
}

async function runReadNote(args: Record<string, unknown>): Promise<ToolResult> {
  const title = typeof args.title === 'string' ? args.title.trim().toLowerCase() : '';
  if (!title) return { text: JSON.stringify({ error: 'нет заголовка' }), count: 0 };
  const notes = alive(await db.notes.toArray());
  const note =
    notes.find((n) => n.title.toLowerCase() === title) ??
    notes.find((n) => n.title.toLowerCase().includes(title));
  if (!note) return { text: JSON.stringify({ error: 'заметка не найдена' }), count: 0 };
  const text = htmlToText(note.content);
  return {
    text: JSON.stringify({
      title: note.title,
      text: text.slice(0, NOTE_CHARS),
      ...(text.length > NOTE_CHARS ? { truncated: true } : {}),
    }),
    count: 1,
  };
}

async function runListFinance(): Promise<ToolResult> {
  const [items, goals, deposits] = await Promise.all([
    alive(await db.expenseItems.toArray()),
    alive(await db.savingsGoals.toArray()),
    alive(await db.savingsDeposits.toArray()),
  ]);
  const active = items.filter((i) => i.active);
  const rows = active.map((i) => ({
    title: i.title,
    kind: i.kind === 'income' ? 'доход' : 'расход',
    amount: i.amount,
    period: i.recurrence,
    monthly: Math.round(monthlyAmount(i)),
    category: i.category || undefined,
    day: i.dayOfMonth ?? undefined,
  }));
  const monthlyExpense = active
    .filter((i) => i.kind === 'expense')
    .reduce((s, i) => s + monthlyAmount(i), 0);
  const monthlyIncome = active
    .filter((i) => i.kind === 'income')
    .reduce((s, i) => s + monthlyAmount(i), 0);
  const savedByGoal = new Map<string, number>();
  for (const d of deposits) savedByGoal.set(d.goalId, (savedByGoal.get(d.goalId) ?? 0) + d.amount);
  const savings = goals
    .filter((g) => !g.archivedAt)
    .map((g) => ({
      title: g.title,
      target: g.targetAmount,
      saved: savedByGoal.get(g.id) ?? 0,
      due: g.targetDate ?? undefined,
    }));
  return {
    text: JSON.stringify({
      items: rows,
      monthlyExpense: Math.round(monthlyExpense),
      monthlyIncome: Math.round(monthlyIncome),
      savings,
    }),
    count: rows.length,
  };
}

async function runListHabits(): Promise<ToolResult> {
  const [habits, logs] = await Promise.all([
    alive(await db.habits.toArray()),
    alive(await db.habitLogs.toArray()),
  ]);
  const week = dayKeyShift(-7);
  const month = dayKeyShift(-28);
  const rows = habits
    .filter((h) => !h.archivedAt)
    .map((h) => {
      const mine = logs.filter((l) => l.habitId === h.id);
      const frozenNow = (h.frozenRanges ?? []).some((r) => !r.to);
      return {
        name: h.name,
        schedule: scheduleLabel(h.schedule),
        target: h.target ? `${h.target} ${h.unit}`.trim() : undefined,
        done7: mine.filter((l) => l.date >= week).length,
        done28: mine.filter((l) => l.date >= month).length,
        frozen: frozenNow || undefined,
      };
    });
  return { text: JSON.stringify({ today: todayKey(), habits: rows }), count: rows.length };
}

async function runListGoals(): Promise<ToolResult> {
  const goals = alive(await db.goals.toArray());
  const rows = goals.map((g) => ({
    title: g.title,
    status: g.status,
    due: g.targetDate ?? undefined,
    progress:
      g.progressMode === 'numeric'
        ? `${g.currentValue ?? 0}/${g.targetValue ?? 0} ${g.unitLabel}`.trim()
        : `${g.progressManual}%`,
    description: g.description.trim() ? g.description.slice(0, SNIPPET_CHARS) : undefined,
  }));
  return { text: JSON.stringify({ goals: rows }), count: rows.length };
}

/** Единицы прогресса словами: ассистент пересказывает это человеку, и
 *  «5/10 lessons» посреди русского ответа выглядит machine-generated. */
const LEARNING_UNITS: Record<LearningItem['progressUnit'], string> = {
  percent: '%',
  pages: 'стр.',
  lessons: 'уроков',
  hours: 'ч',
};

async function runListLearning(): Promise<ToolResult> {
  const items = alive(await db.learningItems.toArray());
  const rows = items.map((i) => ({
    title: i.title,
    author: i.author || undefined,
    kind: i.kind,
    status: i.status,
    progress: `${i.progressCurrent}/${i.progressTarget} ${LEARNING_UNITS[i.progressUnit]}`,
    dueDate: i.dueDate || undefined,
  }));
  return { text: JSON.stringify({ items: rows }), count: rows.length };
}

async function runEnergySummary(): Promise<ToolResult> {
  const month = dayKeyShift(-28);
  const week = dayKeyShift(-7);
  const logs = alive(await db.energyLogs.toArray()).filter((l) => l.date >= month);
  logs.sort((a, b) => a.date.localeCompare(b.date));
  const avg = (rows: typeof logs) =>
    rows.length ? Math.round((rows.reduce((s, l) => s + l.level, 0) / rows.length) * 10) / 10 : null;
  return {
    text: JSON.stringify({
      days: logs.map((l) => ({ date: l.date, level: l.level })),
      avg7: avg(logs.filter((l) => l.date >= week)),
      avg28: avg(logs),
    }),
    count: logs.length,
  };
}

async function runCycleSummary(): Promise<ToolResult> {
  const settings = await db.cycleSettings.get('app');
  if (!settings) return { text: JSON.stringify({ error: 'раздел «Женские дни» не настроен' }), count: 0 };
  // Замок раздела закрывает и этот путь: PIN означает «не показывать без
  // кода», и фоновая выдача данных в API обошла бы его молча.
  if (settings.lock !== 'none') {
    return { text: JSON.stringify({ error: 'раздел под кодом доступа — доступ ИИ закрыт' }), count: 0 };
  }

  const today = todayKey();
  const [cycles, predictions, days, defs] = await Promise.all([
    db.cycles.toArray(),
    db.cyclePredictions.toArray(),
    db.cycleDays.where('date').aboveOrEqual(dayKeyShift(-35)).toArray(),
    db.cycleSymptoms.toArray(),
  ]);
  const label = new Map(defs.map((d) => [d.key, d.label]));

  const current = cycles.find((c) => c.status === 'current');
  const done = cycles
    .filter((c) => c.status === 'complete' && !c.excluded && c.lengthDays)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))
    .slice(0, 6);
  const avgLen = done.length
    ? Math.round(done.reduce((s, c) => s + (c.lengthDays ?? 0), 0) / done.length)
    : null;
  const cycleDay = current
    ? Math.floor((Date.parse(today) - Date.parse(current.startDate)) / 86_400_000) + 1
    : null;

  const latest = predictions.sort((a, b) => b.forCycleStart.localeCompare(a.forCycleStart))[0];
  const prediction =
    settings.predictionsEnabled && latest
      ? { nextStart: latest.predictedNextStart, window80: [latest.lo80, latest.hi80] }
      : undefined;

  // Отдаём только дни, где что-то отмечено. Интимный слой (intimacy) не
  // включается в выборку полей вовсе — см. шапку файла.
  const marks = days
    .filter((d) => (d.bleeding && d.bleeding !== 'none') || d.symptoms?.length || d.bbtC || d.note)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      date: d.date,
      bleeding: d.bleeding && d.bleeding !== 'none' ? d.bleeding : undefined,
      symptoms: d.symptoms?.length ? d.symptoms.map((s) => label.get(s.key) ?? s.key) : undefined,
      bbt: d.bbtC ?? undefined,
      note: d.note ? d.note.slice(0, 80) : undefined,
    }));

  return {
    text: JSON.stringify({
      today,
      currentCycle: current
        ? { start: current.startDate, day: cycleDay, periodLengthDays: current.periodLengthDays }
        : null,
      recentCycles: done.map((c) => ({ start: c.startDate, length: c.lengthDays, period: c.periodLengthDays })),
      avgLength: avgLen,
      prediction,
      days: marks,
    }),
    count: marks.length,
  };
}

/** Исполнить инструмент по имени. Любая ошибка — в content для модели,
 *  а не исключением наружу: упавший вызов не должен ронять весь ответ. */
export async function runTool(name: string, argsJson: string): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = argsJson.trim() ? JSON.parse(argsJson) : {};
    if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
  } catch {
    // Модель прислала битый JSON аргументов — работаем с пустыми.
  }
  try {
    switch (name) {
      case 'list_tasks':
        return await runListTasks(args);
      case 'search_notes':
        return await runSearchNotes(args);
      case 'read_note':
        return await runReadNote(args);
      case 'list_finance':
        return await runListFinance();
      case 'list_habits':
        return await runListHabits();
      case 'list_goals':
        return await runListGoals();
      case 'list_learning':
        return await runListLearning();
      case 'energy_summary':
        return await runEnergySummary();
      case 'cycle_summary':
        return await runCycleSummary();
      default:
        return { text: JSON.stringify({ error: `неизвестный инструмент ${name}` }), count: 0 };
    }
  } catch (e) {
    return { text: JSON.stringify({ error: String(e) }), count: 0 };
  }
}

/** Системная приписка при включённом доступе к данным. Дата обязательна:
 *  «за месяц» и «на этой неделе» без неё не считаются. */
export function toolsSystemPrompt(): string {
  return [
    `Сегодня ${todayKey()}.`,
    'Тебе доступны инструменты чтения данных пользователя из его органайзера LifeHearth:',
    'задачи, заметки, финансы, привычки, цели, обучение, уровень энергии, женские дни (цикл).',
    'Когда вопрос касается личных данных или планов — сначала прочитай их инструментом, потом отвечай по фактам.',
    'Не выдумывай записи, которых нет. Отвечай на языке пользователя, кратко и по делу.',
  ].join(' ');
}
