import type { Recurrence, Task } from '../../db/types';
import { db } from '../../db/db';
import { create, now, remove, uid, update } from '../../db/repo';
import { nextOccurrence } from '../../lib/recurrence';
import { nextWindowStart } from '../../lib/taskDates';
import { todayKey } from '../../lib/dates';
import { cancelReminder, scheduleReminder } from '../../lib/push';

/**
 * Переключение выполненности задачи.
 * Для повторяющейся задачи при выполнении создаётся следующее повторение —
 * кроме ручного повтора: он засыпает на месте до launchTasks.
 * Возвращает dueDate нового повторения (для тоста «Повторится …») или null.
 */
export async function toggleTask(task: Task): Promise<string | null> {
  if (task.completedAt) {
    await update(db.tasks, task.id, { completedAt: null, spawnedId: null });
    void scheduleReminder(task); // снова активна — вернуть напоминание
    // Снятая отметка с повторяющейся задачи убирает и созданный при
    // выполнении следующий повтор — пока он живой, не выполнен и не тронут
    // (тот же срок, что мы ему дали). Иначе после промаха по чекбоксу
    // оставались две задачи: исходная и «следующая» через неделю.
    if (task.spawnedId) {
      const spawned = await db.tasks.get(task.spawnedId);
      // Только нетронутый: правленный повтор (updatedAt ушёл от createdAt) — уже
      // чья-то работа, её не стираем.
      if (spawned && !spawned.deletedAt && !spawned.completedAt && spawned.recurrence && spawned.updatedAt === spawned.createdAt) {
        void cancelReminder(spawned.id, spawned.remindBefore != null);
        await remove(db.tasks, spawned.id);
      }
    }
    return null;
  }

  await update(db.tasks, task.id, { completedAt: now() });
  void cancelReminder(task.id, task.remindBefore != null); // выполнена — напоминание не нужно

  // Ручной повтор следующего не создаёт: задача засыпает на месте, пока её
  // не запустят (launchTasks).
  if (task.recurrence && task.recurrence.type !== 'manual') return scheduleNext(task, task.recurrence);

  return null;
}

/** Следующий круг по расписанию для отмеченной задачи: копия со сроком, у
 *  исходной — spawnedId. Возвращает срок копии. Зовёт и редактор: спящую
 *  ручную задачу перевели на расписание — она уже сделана, и следующий круг
 *  заводится сразу, как при отметке, иначе серия молча обрывалась бы. */
export async function scheduleNext(task: Task, rec: Exclude<Recurrence, { type: 'manual' }>): Promise<string> {
  const nextDue = nextOccurrence(rec, task.dueDate);
  const next = await spawnNext({ ...task, recurrence: rec }, nextDue);
  await update(db.tasks, task.id, { spawnedId: next.id });
  return nextDue;
}

/** Копия повторяющейся задачи для следующего круга: со сроком dueDate (null —
 *  без срока, как у ручного повтора), с чистым чеклистом. */
async function spawnNext(task: Task, dueDate: string | null): Promise<Task> {
  const next = await create(db.tasks, {
    title: task.title,
    notes: task.notes,
    projectId: task.projectId,
    // goalId НЕ переносим: иначе каждое выполнение повторяющейся задачи
    // плодило бы новую запись в прогрессе цели (знаменатель рос бы безгранично).
    goalId: null,
    priority: task.priority,
    dueDate,
    // Окно повторяется вместе с дедлайном той же длины: «каждый месяц с 10
    // по 25» остаётся «с 10 по 25», а не превращается в точку.
    startDate:
      dueDate && task.startDate && task.dueDate ? nextWindowStart(task.startDate, task.dueDate, dueDate) : null,
    // Время и напоминание без срока не значат ничего — как в форме задачи.
    dueTime: dueDate ? (task.dueTime ?? null) : null,
    duration: dueDate ? (task.duration ?? null) : null,
    remindBefore: dueDate ? (task.remindBefore ?? null) : null,
    completedAt: null,
    checklist: task.checklist.map((i) => ({ id: uid(), text: i.text, done: false })),
    recurrence: task.recurrence,
    tags: [...task.tags],
    // Запущенная ручная задача встаёт на то же место — и во «Временных», если
    // была там. Повтор по расписанию пометку не переносит, как и раньше.
    ...(task.recurrence?.type === 'manual' && { temporary: task.temporary }),
    sortOrder: task.sortOrder,
  });
  if (dueDate) void scheduleReminder(next); // напоминание для следующего повторения
  return next;
}

/** «Спит» — отмеченная задача ручного повтора, которую ещё не запустили
 *  заново: стоит на своём месте в списке, а не в «Выполненных». Замороженная
 *  не спит: отмеченная из «Календаря» или цели, она иначе выпала бы из обоих
 *  списков «Задач» — активный не берёт замороженные, «Выполненные» — спящие. */
export function isSleeping(task: Task): boolean {
  return Boolean(task.completedAt) && task.recurrence?.type === 'manual' && !task.spawnedId && !task.frozenAt;
}

/**
 * Запуск спящих задач ручного повтора. Отмеченная остаётся выполненной — в
 * истории и статистике, — а на её месте в работу встаёт свежая копия без
 * срока: при гибком графике срок, поставленный за человека, был бы враньём.
 * Снятие отметки с отмеченной (промах) убирает и копию — как у расписания.
 */
export async function launchTasks(tasks: Task[]): Promise<void> {
  for (const { id } of tasks) {
    if (launching.has(id)) continue;
    launching.add(id);
    try {
      // Свежая запись, а не снимок из рендера: тот мог устареть.
      const task = await db.tasks.get(id);
      if (!task || task.deletedAt || !isSleeping(task)) continue;
      const next = await spawnNext(task, null);
      await update(db.tasks, id, { spawnedId: next.id });
    } finally {
      launching.delete(id);
    }
  }
}

// Двойной тап по ↻ (или ↻ у строки, следом ↻ у заголовка) приходит, пока
// первая запись ещё не легла: оба вызова видят задачу спящей — две копии.
const launching = new Set<string>();

/**
 * Отметить задачу «пропущена» (не выполнена): фиксируем пропуск для статистики
 * и возвращаем задачу в штатный режим — повторяющаяся переходит к следующему
 * повтору, разовая переносится на сегодня (перестаёт быть просроченной).
 */
export async function skipTask(task: Task): Promise<void> {
  if (task.completedAt) return;
  const skippedCount = (task.skippedCount ?? 0) + 1;
  // Ручной повтор без расписания пропускается как разовая задача.
  const rec = task.recurrence?.type === 'manual' ? null : task.recurrence;
  const nextDue = rec ? nextOccurrence(rec, task.dueDate) : todayKey();
  // Повторяющаяся уносит окно с собой; разовая переносится на сегодня точкой —
  // её окно уже прожито.
  const nextStart =
    rec && task.startDate && task.dueDate
      ? nextWindowStart(task.startDate, task.dueDate, nextDue)
      : null;
  await update(db.tasks, task.id, { dueDate: nextDue, startDate: nextStart, skippedCount });
  void scheduleReminder({ ...task, dueDate: nextDue });
}

/**
 * Заморозка: ставим задачи на паузу (frozenAt = сейчас) и снимаем их напоминания.
 * Замороженная задача исключена из Today/статистики/активного списка и не
 * краснеет/желтеет — «как будто для неё остановилось время».
 */
export async function freezeTasks(tasks: Task[]): Promise<void> {
  const ts = now();
  for (const t of tasks) {
    if (t.frozenAt || t.completedAt) continue;
    await update(db.tasks, t.id, { frozenAt: ts });
    void cancelReminder(t.id, t.remindBefore != null);
  }
}

/**
 * Разморозка одной задачи. Если за время паузы срок утёк в прошлое — переносим
 * на сегодня (повтор продолжится со следующего выполнения), чтобы задача не
 * всплыла мгновенно просроченной. Возвращаем напоминание.
 */
export async function unfreezeTask(task: Task): Promise<void> {
  if (!task.frozenAt) return;
  const changes: Partial<Omit<Task, 'id' | 'createdAt'>> = { frozenAt: null };
  if (task.dueDate && task.dueDate < todayKey()) changes.dueDate = todayKey();
  await update(db.tasks, task.id, changes);
  void scheduleReminder({ ...task, ...changes } as Task);
}

/** Разморозить все замороженные задачи разом. */
export async function unfreezeAll(): Promise<void> {
  const frozen = (await db.tasks.toArray()).filter((t) => !t.deletedAt && t.frozenAt);
  for (const t of frozen) await unfreezeTask(t);
}
