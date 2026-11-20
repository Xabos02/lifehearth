// Инструменты ЗАПИСИ ассистента. Просьба Влада 20.11.2026: «дай ИИ права
// вносить изменения… он даже не может мне создать шаблон тренировок».
//
// Решение Влада о подтверждении (20.11): создание, правка и отметка
// «выполнено» — сразу, под ответом карточка «Сделано · Отменить»; удаление
// модель только предлагает — исполняется кнопкой человека. Причина — подмена
// инструкций (prompt injection): текст заметок и задач уходит модели, и
// «инструкция» из вставленной статьи могла бы её руками что-нибудь стереть.
// Потолок изменений за ответ держит agentLoop (MAX_WRITES).
//
// Вне доступа — синхронизация, «Женские дни», семья, замеры здоровья: для них
// инструментов нет вовсе.
//
// Запись — через те же функции, что у экранов (newTaskSortOrder, toggleTask,
// addTemplate, addWorkoutSession), и с теми же полями по умолчанию, что у
// шторок: запись ассистента ничем не отличается от сделанной руками.

import type { Table } from 'dexie';
import { db } from '../../db/db';
import { alive, create, now, remove, restore, uid, update, updateMany } from '../../db/repo';
import type {
  AiAction,
  AiActionKind,
  BaseEntity,
  HabitSchedule,
  Priority,
  Recurrence,
  Task,
  WorkoutTemplateItem,
  WorkoutType,
} from '../../db/types';
import { newSortOrder, newTaskSortOrder, toggleTask } from '../../features/tasks/taskActions';
import { addTemplate } from '../../features/health/templateRepo';
import { addWorkout, addWorkoutSession, type WorkoutDraft } from '../../features/health/workoutRepo';
import { addExerciseDef } from '../../features/health/exerciseDefRepo';
import { cleanExercises } from '../../features/health/exercises';
import { workoutKind } from '../../features/health/workouts';
import { PRESET_COLORS } from '../colors';
import { isDateKey, todayKey } from '../dates';
import { cancelReminder } from '../push';
import { t } from '../i18n';

/** Короткий id для модели — 8 символов UUID. Полный id на 300 задач — это
 *  ~10 тыс. лишних символов в каждом запросе; совпадение двух коротких
 *  ловит findById и просит модель уточнить. */
export const shortId = (id: string) => id.slice(0, 8);

const KIND_TABLE: Record<AiActionKind, string> = {
  task: 'tasks',
  project: 'projects',
  note: 'notes',
  habit: 'habits',
  goal: 'goals',
  workout: 'workouts',
  template: 'workoutTemplates',
  expense: 'expenseItems',
  income: 'expenseItems',
  savings: 'savingsGoals',
  deposit: 'savingsDeposits',
};

const tableOf = (kind: AiActionKind) => db.table(KIND_TABLE[kind]) as Table<BaseEntity, string>;

export interface WriteResult {
  text: string;
  count: number;
  actions?: AiAction[];
}

/** Ошибка аргументов — модели текстом, чтобы она поправилась сама. */
class ArgError extends Error {}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN;
  return Number.isFinite(n) ? n : null;
};
const has = (args: Record<string, unknown>, k: string) => args[k] !== undefined;
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

function dateArg(v: unknown, what: string): string | null {
  const s = str(v);
  if (!s) return null;
  if (!isDateKey(s)) throw new ArgError(`${what}: нужна дата YYYY-MM-DD, а пришло «${s}»`);
  return s;
}

function timeArg(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m || +m[1] > 23 || +m[2] > 59) throw new ArgError(`время: нужно HH:mm, а пришло «${s}»`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

const PRIORITY: Record<string, Priority> = { none: 0, low: 1, medium: 2, high: 3 };

/** Повтор от модели → Recurrence. Без дней недели — день срока (или
 *  сегодняшний), без числа месяца — число срока: как подставляет форма. */
function recurrenceArg(v: unknown, due: string | null): Recurrence | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const interval = Math.max(1, Math.round(num(r.interval) ?? 1));
  const anchor = due ? new Date(`${due}T12:00:00`) : new Date();
  switch (r.every) {
    case 'day':
      return { type: 'daily', interval };
    case 'week': {
      const days = (Array.isArray(r.weekdays) ? r.weekdays : []).map(num).filter((d): d is number => d !== null && d >= 1 && d <= 7);
      const isoDay = ((anchor.getDay() + 6) % 7) + 1;
      return { type: 'weekly', interval, weekdays: days.length ? [...new Set(days)].sort((a, b) => a - b) : [isoDay] };
    }
    case 'month': {
      const day = num(r.day);
      return { type: 'monthly', interval, dayOfMonth: Math.min(31, Math.max(1, Math.round(day ?? anchor.getDate()))) };
    }
    case 'year':
      return { type: 'yearly', interval };
    case 'manual':
      return { type: 'manual' };
    case 'none':
      return null;
    default:
      throw new ArgError('repeat.every: day, week, month, year, manual или none');
  }
}

/** Запись по короткому id (или полному). Совпадений два — просим уточнить. */
async function findById<T extends BaseEntity>(table: Table<T, string>, raw: unknown): Promise<T> {
  const sid = str(raw);
  if (!sid) throw new ArgError('нужен id записи — возьми его из инструмента чтения');
  const hits = alive(await table.where(':id').startsWith(sid).toArray());
  if (!hits.length) throw new ArgError(`запись с id ${sid} не найдена`);
  if (hits.length > 1) throw new ArgError(`id ${sid} подходит к нескольким записям — дай больше символов`);
  return hits[0];
}

/** Проект по имени; нет такого — заводится, как в форме задачи (тот же
 *  цвет и значок по умолчанию). Совпадение — только точное: «Ремонт» не
 *  должен молча лечь в «Ремонт машины». */
async function projectArg(v: unknown, out: AiAction[]): Promise<string | null> {
  const name = str(v);
  if (!name) return null;
  const projects = alive(await db.projects.toArray()).filter((p) => !p.archivedAt);
  const hit = projects.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  const p = await create(db.projects, { name, color: PRESET_COLORS[0], emoji: '📁', sortOrder: newSortOrder(), archivedAt: null });
  out.push({ op: 'create', kind: 'project', ids: [p.id], title: name, state: 'done' });
  return p.id;
}

const done = (actions: AiAction[], extra: Record<string, unknown> = {}): WriteResult => ({
  text: JSON.stringify({ ok: true, ...extra }),
  count: actions.length,
  actions,
});

// ─── Задачи ───────────────────────────────────────────────────────────────

async function createTask(args: Record<string, unknown>): Promise<WriteResult> {
  const title = str(args.title);
  if (!title) throw new ArgError('нет названия задачи');
  const actions: AiAction[] = [];
  let due = dateArg(args.due, 'срок');
  let start = dateArg(args.start, 'начало');
  if (start && !due) [due, start] = [start, null];
  if (start && due && start > due) [start, due] = [due, start];
  const time = due ? timeArg(args.time) : null;
  const priority = PRIORITY[str(args.priority)] ?? 0;
  const recurrence = recurrenceArg(args.repeat, due);
  const projectId = await projectArg(args.project, actions);
  const task = await create(db.tasks, {
    title,
    notes: str(args.notes),
    projectId,
    goalId: null,
    priority,
    dueDate: due,
    startDate: start,
    dueTime: time,
    duration: null,
    remindBefore: null,
    completedAt: null,
    checklist: strList(args.checklist).map((text) => ({ id: uid(), text, done: false })),
    recurrence,
    tags: strList(args.tags),
    sortOrder: await newTaskSortOrder(projectId, priority),
  });
  actions.push({ op: 'create', kind: 'task', ids: [task.id], title, state: 'done' });
  return done(actions, { id: shortId(task.id) });
}

/** Правка задачи: меняется только то, что модель передала. Пустая строка
 *  снимает поле (срок, время, заметку). Прежние значения — в action.before,
 *  отмена кладёт их обратно. */
async function updateTask(args: Record<string, unknown>): Promise<WriteResult> {
  const task = await findById(db.tasks, args.id);
  const actions: AiAction[] = [];
  const changes: Partial<Task> = {};
  if (has(args, 'title')) {
    const title = str(args.title);
    if (!title) throw new ArgError('название не может быть пустым');
    changes.title = title;
  }
  if (has(args, 'notes')) changes.notes = str(args.notes);
  if (has(args, 'due')) changes.dueDate = dateArg(args.due, 'срок');
  if (has(args, 'start')) changes.startDate = dateArg(args.start, 'начало');
  const due = changes.dueDate !== undefined ? changes.dueDate : task.dueDate;
  const start = changes.startDate !== undefined ? changes.startDate : (task.startDate ?? null);
  if (start && (!due || start > due)) throw new ArgError('начало периода должно быть не позже срока');
  if (has(args, 'time')) changes.dueTime = timeArg(args.time);
  // Время и напоминание без срока не значат ничего — как в форме задачи.
  if (!due) Object.assign(changes, { dueTime: null, remindBefore: null, startDate: null });
  if (has(args, 'priority')) {
    changes.priority = PRIORITY[str(args.priority)] ?? task.priority;
    if (changes.priority === 3 && task.priority !== 3) changes.sortOrder = newSortOrder();
  }
  if (has(args, 'repeat')) changes.recurrence = recurrenceArg(args.repeat, due);
  if (has(args, 'tags')) changes.tags = strList(args.tags);
  if (has(args, 'checklist')) {
    // Пункт с тем же текстом сохраняет свою галочку.
    const was = new Map(task.checklist.map((c) => [c.text, c]));
    changes.checklist = strList(args.checklist).map((text) => was.get(text) ?? { id: uid(), text, done: false });
  }
  if (has(args, 'project')) changes.projectId = str(args.project) ? await projectArg(args.project, actions) : null;

  const keys = Object.keys(changes) as (keyof Task)[];
  const changed = keys.filter((k) => JSON.stringify(changes[k]) !== JSON.stringify(task[k] ?? null));
  if (!changed.length) return { text: JSON.stringify({ ok: true, note: 'менять нечего' }), count: 0 };
  const before = Object.fromEntries(changed.map((k) => [k, task[k] ?? null]));
  await update(db.tasks, task.id, Object.fromEntries(changed.map((k) => [k, changes[k]])));
  actions.push({ op: 'update', kind: 'task', ids: [task.id], title: changes.title ?? task.title, state: 'done', before });
  return done(actions);
}

async function completeTask(args: Record<string, unknown>): Promise<WriteResult> {
  const task = await findById(db.tasks, args.id);
  if (task.completedAt) return { text: JSON.stringify({ ok: true, note: 'уже выполнена' }), count: 0 };
  const next = await toggleTask(task);
  return done(
    [{ op: 'complete', kind: 'task', ids: [task.id], title: task.title, state: 'done' }],
    next ? { nextRepeat: next } : {},
  );
}

// ─── Заметки, привычки, цели ─────────────────────────────────────────────

/** Текст модели — markdown. В браузере он идёт тем же путём, что вставка из
 *  буфера: списки, жирный, заголовки становятся разметкой заметки. Модули
 *  грузятся лениво — DOMPurify ставит хуки при загрузке и без DOM (юниты в
 *  Node) падает; там текст ложится строками как есть. */
async function noteHtml(text: string): Promise<string> {
  if (typeof DOMParser === 'undefined') {
    const esc = (l: string) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return text.split('\n').map((l) => `<div>${esc(l) || '<br>'}</div>`).join('');
  }
  const [{ renderMarkdown }, { clipboardHtmlToNoteHtml }] = await Promise.all([
    import('../../features/ai/renderMarkdown'),
    import('../../features/notes/pasteHtml'),
  ]);
  return clipboardHtmlToNoteHtml(renderMarkdown(text));
}

async function createNote(args: Record<string, unknown>): Promise<WriteResult> {
  const text = typeof args.text === 'string' ? args.text : '';
  const title = str(args.title) || text.trim().split('\n')[0].slice(0, 120);
  if (!title) throw new ArgError('нет названия и текста заметки');
  const note = await create(db.notes, { title, content: await noteHtml(text), tags: [], pinned: false });
  return done([{ op: 'create', kind: 'note', ids: [note.id], title, state: 'done' }], { id: shortId(note.id) });
}

async function createHabit(args: Record<string, unknown>): Promise<WriteResult> {
  const name = str(args.name);
  if (!name) throw new ArgError('нет названия привычки');
  const days = (Array.isArray(args.days) ? args.days : []).map(num).filter((d): d is number => d !== null && d >= 1 && d <= 7);
  const schedule: HabitSchedule = days.length ? { type: 'weekdays', weekdays: [...new Set(days)].sort((a, b) => a - b) } : { type: 'daily' };
  const target = num(args.target);
  const habit = await create(db.habits, {
    name,
    emoji: str(args.emoji) || '✅',
    color: PRESET_COLORS[0],
    schedule,
    target: target && target > 0 ? target : null,
    unit: target && target > 0 ? str(args.unit) : '',
    goalId: null,
    archivedAt: null,
    sortOrder: Date.now(),
  });
  return done([{ op: 'create', kind: 'habit', ids: [habit.id], title: name, state: 'done' }], { id: shortId(habit.id) });
}

async function createGoal(args: Record<string, unknown>): Promise<WriteResult> {
  const title = str(args.title);
  if (!title) throw new ArgError('нет названия цели');
  const target = num(args.target);
  const numeric = !!target && target > 0;
  const goal = await create(db.goals, {
    title,
    description: str(args.description),
    color: PRESET_COLORS[0],
    targetDate: dateArg(args.due, 'срок'),
    progressMode: numeric ? 'numeric' : 'manual',
    targetValue: numeric ? target : null,
    unitLabel: numeric ? str(args.unit) : '',
    status: 'active',
    progressManual: 0,
    currentValue: numeric ? 0 : null,
    sortOrder: Date.now(),
  });
  return done([{ op: 'create', kind: 'goal', ids: [goal.id], title, state: 'done' }], { id: shortId(goal.id) });
}

// ─── Спорт ────────────────────────────────────────────────────────────────

const BUILTIN: WorkoutType[] = ['run', 'strength', 'boxing', 'kettlebell', 'stretch', 'walk', 'bike', 'swim', 'other'];

/** Вид от модели → строка вида шаблона или тренировки. Вида нет в списке, но
 *  есть название — своё упражнение, через тот же справочник, что «+ Своё». */
async function itemArg(raw: unknown): Promise<WorkoutTemplateItem> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = str(r.name);
  let type = (BUILTIN as string[]).includes(str(r.type)) ? (str(r.type) as WorkoutType) : null;
  let customLabel: string | null = null;
  let customColor: string | null = null;
  if ((!type || type === 'other') && name) {
    const def = await addExerciseDef(name);
    type = 'custom';
    customLabel = def.label;
    customColor = def.color;
  }
  type ??= 'other';
  const hasDistance = type !== 'custom' && workoutKind(type).hasDistance;
  const km = num(r.distance_km);
  const list = Array.isArray(r.exercises) ? r.exercises : [];
  return {
    type,
    customLabel,
    customColor,
    minutes: Math.max(0, Math.round(num(r.minutes) ?? 0)),
    distanceKm: hasDistance && km && km > 0 ? Math.round(km * 100) / 100 : null,
    exercises: cleanExercises(
      list.map((e) => {
        const x = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
        const unit = str(x.unit);
        return {
          name: str(x.name),
          sets: String(num(x.sets) ?? ''),
          reps: String(num(x.reps) ?? ''),
          repsTo: String(num(x.reps_to) ?? ''),
          unit: unit === 'sec' || unit === 'min' || unit === 'm' ? unit : null,
          weight: str(x.weight),
          rest: str(x.rest),
          note: str(x.note),
        };
      }),
    ),
  };
}

async function itemsArg(v: unknown): Promise<WorkoutTemplateItem[]> {
  const raw = Array.isArray(v) ? v : [];
  if (!raw.length) throw new ArgError('нужен хотя бы один вид в items');
  const out: WorkoutTemplateItem[] = [];
  for (const r of raw) out.push(await itemArg(r));
  return out;
}

const kindsTitle = (items: WorkoutTemplateItem[]) =>
  items.map((it) => (it.type === 'custom' ? (it.customLabel ?? '') : t(workoutKind(it.type).label))).join(' + ');

async function createTemplate(args: Record<string, unknown>): Promise<WriteResult> {
  const name = str(args.name);
  if (!name) throw new ArgError('нет названия шаблона');
  const items = await itemsArg(args.items);
  const total = Math.round(num(args.total_minutes) ?? 0);
  const tpl = await addTemplate({ name, items, totalMinutes: total > 0 ? total : undefined, note: str(args.note) || undefined });
  return done([{ op: 'create', kind: 'template', ids: [tpl.id], title: name, state: 'done' }], { id: shortId(tpl.id) });
}

async function logWorkout(args: Record<string, unknown>): Promise<WriteResult> {
  const items = await itemsArg(args.items);
  const date = dateArg(args.date, 'дата') ?? todayKey();
  const e = Math.round(num(args.effort) ?? 0);
  const drafts: WorkoutDraft[] = items.map((it) => ({
    ...it,
    date,
    effort: e >= 1 && e <= 4 ? (e as 1 | 2 | 3 | 4) : null,
    note: str(args.note),
    source: 'manual',
    groupId: null,
  }));
  const rows = drafts.length === 1 ? [await addWorkout(drafts[0])] : await addWorkoutSession(drafts);
  return done([{ op: 'create', kind: 'workout', ids: rows.map((r) => r.id), title: `${kindsTitle(items)}, ${date}`, state: 'done' }]);
}

// ─── Финансы ──────────────────────────────────────────────────────────────

const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

async function createExpense(args: Record<string, unknown>): Promise<WriteResult> {
  const title = str(args.title);
  const amount = num(args.amount);
  if (!title) throw new ArgError('нет названия');
  if (!amount || amount <= 0) throw new ArgError('сумма должна быть больше нуля');
  const kind = args.kind === 'income' ? 'income' : 'expense';
  const period = ['monthly', 'weekly', 'yearly', 'oneoff'].includes(str(args.period)) ? str(args.period) : 'monthly';
  const day = num(args.day);
  const item = await create(db.expenseItems, {
    title,
    amount,
    kind,
    category: str(args.category),
    recurrence: period as 'monthly' | 'weekly' | 'yearly' | 'oneoff',
    dayOfMonth: period === 'monthly' && day ? Math.min(31, Math.max(1, Math.round(day))) : null,
    notes: '',
    active: true,
    sortOrder: Date.now(),
  });
  return done([{ op: 'create', kind, ids: [item.id], title: `${title}, ${rub(amount)}`, state: 'done' }], { id: shortId(item.id) });
}

async function createSavings(args: Record<string, unknown>): Promise<WriteResult> {
  const title = str(args.title);
  const target = num(args.target);
  if (!title) throw new ArgError('нет названия копилки');
  if (!target || target <= 0) throw new ArgError('цель копилки должна быть больше нуля');
  const goal = await create(db.savingsGoals, {
    title,
    emoji: str(args.emoji) || '🎯',
    color: '#7c9cff', // первый цвет шторки копилки
    targetAmount: target,
    targetDate: dateArg(args.due, 'срок'),
    note: '',
    archivedAt: null,
    sortOrder: Date.now(),
  });
  return done([{ op: 'create', kind: 'savings', ids: [goal.id], title, state: 'done' }], { id: shortId(goal.id) });
}

async function addDeposit(args: Record<string, unknown>): Promise<WriteResult> {
  const goal = await findById(db.savingsGoals, args.savings_id);
  const amount = num(args.amount);
  if (!amount) throw new ArgError('сумма не может быть нулевой');
  if (amount < 0) {
    // Снять больше накопленного нельзя — как в шторке пополнения.
    const saved = alive(await db.savingsDeposits.where('goalId').equals(goal.id).toArray()).reduce((s, d) => s + d.amount, 0);
    if (-amount > saved) throw new ArgError(`накоплено только ${saved} ₽ — снять больше нельзя`);
  }
  const dep = await create(db.savingsDeposits, { goalId: goal.id, amount, date: dateArg(args.date, 'дата') ?? todayKey(), note: str(args.note) });
  return done([{ op: 'create', kind: 'deposit', ids: [dep.id], title: `${goal.title}: ${amount > 0 ? '+' : '−'}${rub(Math.abs(amount))}`, state: 'done' }]);
}

// ─── Удаление — только предложение ───────────────────────────────────────

async function deleteRecord(args: Record<string, unknown>): Promise<WriteResult> {
  const type = str(args.type);
  let a: Pick<AiAction, 'kind' | 'ids' | 'title'>;
  if (type === 'task') {
    const x = await findById(db.tasks, args.id);
    a = { kind: 'task', ids: [x.id], title: x.title };
  } else if (type === 'note') {
    const x = await findById(db.notes, args.id);
    a = { kind: 'note', ids: [x.id], title: x.title || t('Без названия') };
  } else if (type === 'template') {
    const x = await findById(db.workoutTemplates, args.id);
    a = { kind: 'template', ids: [x.id], title: x.name };
  } else if (type === 'expense') {
    const x = await findById(db.expenseItems, args.id);
    a = { kind: x.kind === 'income' ? 'income' : 'expense', ids: [x.id], title: x.title };
  } else throw new ArgError('удалять можно только task, note, template, expense');
  return {
    text: JSON.stringify({ ok: true, pending: 'удаление ждёт кнопки «Удалить» под ответом; не пиши, что запись удалена' }),
    count: 1,
    actions: [{ op: 'delete', ...a, state: 'pending' }],
  };
}

// ─── Определения для модели ──────────────────────────────────────────────

const S = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const N = (description?: string) => ({ type: 'number', ...(description ? { description } : {}) });
const ID = S('короткий id из инструмента чтения');
const TASK_FIELDS = {
  title: S(),
  project: S('имя проекта; нет такого — будет создан'),
  due: S('срок YYYY-MM-DD'),
  start: S('начало периода YYYY-MM-DD, если срок — период'),
  time: S('время HH:mm (только со сроком)'),
  priority: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
  repeat: {
    type: 'object',
    properties: {
      every: { type: 'string', enum: ['day', 'week', 'month', 'year', 'manual', 'none'] },
      interval: N('каждые N, по умолчанию 1'),
      weekdays: { type: 'array', items: { type: 'integer' }, description: 'для week: 1=Пн … 7=Вс' },
      day: N('для month: число месяца'),
    },
    required: ['every'],
  },
  checklist: { type: 'array', items: { type: 'string' }, description: 'пункты чек-листа' },
  tags: { type: 'array', items: { type: 'string' } },
  notes: S('описание'),
};
const WORKOUT_ITEMS = {
  type: 'array',
  // Без этой строки Qwen (живая проба 20.11) клала каждое упражнение отдельным
  // видом: в шаблоне выходило четыре «Силовых» по одному упражнению.
  description: 'виды тренировки; все упражнения одного вида — в exercises одного элемента',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: BUILTIN },
      name: S('своё название вида (йога, скалолазание), если его нет в type; не упражнение'),
      minutes: N(),
      distance_km: N(),
      exercises: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: S(),
            sets: N('подходы'),
            reps: N('повторы или величина в unit'),
            reps_to: N('верх диапазона 6–8'),
            unit: { type: 'string', enum: ['sec', 'min', 'm'], description: 'нет — повторы' },
            weight: S('вес словами: «+10 кг»'),
            rest: S('отдых: «90 сек»'),
            note: S(),
          },
          required: ['name'],
        },
      },
    },
  },
};

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } },
});

export const WRITE_TOOL_DEFS = [
  fn('create_task', 'Создать задачу.', TASK_FIELDS, ['title']),
  fn('update_task', 'Изменить задачу: только переданные поля; пустая строка снимает поле.', { id: ID, ...TASK_FIELDS }, ['id']),
  fn('complete_task', 'Отметить задачу выполненной.', { id: ID }, ['id']),
  fn('create_note', 'Создать заметку; text можно в markdown.', { title: S(), text: S() }, ['title']),
  fn('create_habit', 'Создать привычку.', {
    name: S(),
    emoji: S(),
    days: { type: 'array', items: { type: 'integer' }, description: 'дни 1=Пн … 7=Вс; нет — каждый день' },
    target: N('число за день для счётчика; нет — галочка'),
    unit: S('единица счётчика'),
  }, ['name']),
  fn('create_goal', 'Создать цель.', { title: S(), description: S(), due: S('срок YYYY-MM-DD'), target: N('числовая цель'), unit: S() }, ['title']),
  fn('create_workout_template', 'Создать шаблон тренировки в «Здоровье → Спорт».', {
    name: S(),
    items: WORKOUT_ITEMS,
    total_minutes: N('общее время по плану'),
    note: S('памятка: правила, прогрессия'),
  }, ['name', 'items']),
  fn('log_workout', 'Записать проведённую тренировку.', {
    date: S('YYYY-MM-DD, по умолчанию сегодня'),
    items: WORKOUT_ITEMS,
    effort: N('1 легко · 2 нормально · 3 тяжело · 4 на пределе'),
    note: S(),
  }, ['items']),
  fn('create_expense', 'Добавить регулярный или разовый расход или доход в «Финансы».', {
    title: S(),
    amount: N('рубли'),
    kind: { type: 'string', enum: ['expense', 'income'] },
    period: { type: 'string', enum: ['monthly', 'weekly', 'yearly', 'oneoff'] },
    category: S(),
    day: N('для monthly: день списания'),
  }, ['title', 'amount']),
  fn('create_savings_goal', 'Создать копилку.', { title: S(), target: N('цель, рубли'), due: S('срок YYYY-MM-DD'), emoji: S() }, ['title', 'target']),
  fn('add_deposit', 'Пополнить копилку (минус — снятие).', { savings_id: ID, amount: N(), date: S(), note: S() }, ['savings_id', 'amount']),
  fn('delete_record', 'Предложить удаление; удалит пользователь кнопкой под ответом.', {
    type: { type: 'string', enum: ['task', 'note', 'template', 'expense'] },
    id: ID,
  }, ['type', 'id']),
];

const WRITERS: Record<string, (args: Record<string, unknown>) => Promise<WriteResult>> = {
  create_task: createTask,
  update_task: updateTask,
  complete_task: completeTask,
  create_note: createNote,
  create_habit: createHabit,
  create_goal: createGoal,
  create_workout_template: createTemplate,
  log_workout: logWorkout,
  create_expense: createExpense,
  create_savings_goal: createSavings,
  add_deposit: addDeposit,
  delete_record: deleteRecord,
};

export const WRITE_TOOLS: ReadonlySet<string> = new Set(Object.keys(WRITERS));

/** Исполнить инструмент записи. Ошибка аргументов — текстом для модели. */
export async function runWriteTool(name: string, args: Record<string, unknown>): Promise<WriteResult> {
  try {
    return await WRITERS[name](args);
  } catch (e) {
    return { text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), count: 0 };
  }
}

// ─── Отмена и подтверждение (кнопки карточки) ────────────────────────────

async function revert(a: AiAction): Promise<void> {
  const table = tableOf(a.kind);
  switch (a.op) {
    case 'create':
      // Мягко, одной записью: тренировка из нескольких видов уходит целиком.
      await updateMany(table, a.ids.map((id) => ({ id, changes: { deletedAt: now() } })));
      return;
    case 'update':
      await update(table, a.ids[0], a.before ?? {});
      return;
    case 'complete': {
      // Снятие отметки убирает и заведённый ею следующий повтор (toggleTask).
      const task = await db.tasks.get(a.ids[0]);
      if (task?.completedAt) await toggleTask(task);
      return;
    }
    case 'delete':
      for (const id of a.ids) await restore(table, id);
  }
}

async function erase(a: AiAction): Promise<void> {
  for (const id of a.ids) {
    if (a.kind === 'task') {
      const task = await db.tasks.get(id);
      if (task) void cancelReminder(id, task.remindBefore != null);
    }
    await remove(tableOf(a.kind), id);
  }
}

/** Кнопка карточки: «Отменить» / «Вернуть» (undo), «Удалить» (confirm),
 *  «Оставить» (keep). Состояние пишется в само сообщение — карточка
 *  переживает перезагрузку. Сообщения чата — мимо repo, как в llmRepo. */
export async function settleAction(messageId: string, i: number, how: 'undo' | 'confirm' | 'keep'): Promise<void> {
  const m = await db.llmMessages.get(messageId);
  const a = m?.actions?.[i];
  if (!m?.actions || !a) return;
  let state: AiAction['state'] | null = null;
  if (how === 'undo' && a.state === 'done') {
    await revert(a);
    state = 'undone';
  } else if (how === 'confirm' && a.state === 'pending') {
    await erase(a);
    state = 'done';
  } else if (how === 'keep' && a.state === 'pending') state = 'undone';
  if (!state) return;
  const actions = m.actions.map((x, j) => (j === i ? { ...x, state } : x));
  await db.llmMessages.update(messageId, { actions, updatedAt: now() });
}
