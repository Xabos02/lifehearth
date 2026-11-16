import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { EnergyLevel } from '../../db/types';
import { isActiveOn, isLogDone } from '../../lib/habits';
import { splitByLevel, windowDates } from '../../lib/energy';

/** Привычки и закрытые задачи в дни с низкими и высокими силами — общий
 *  расчёт для раздела «Энергия» и блока в статистике. */
export function useEnergySplits(byDate: Map<string, EnergyLevel>, today: string, days: number) {
  const habitsRaw = useLiveQuery(() => db.habits.toArray(), []);
  const habitLogsRaw = useLiveQuery(() => db.habitLogs.toArray(), []);
  const tasksRaw = useLiveQuery(() => db.tasks.toArray(), []);
  const window = windowDates(today, days);

  // Привычки: доля выполненных из запланированных на день. Дни без плана
  // (расписание, заморозка) в связку не идут — делить было бы не на что.
  const habits = alive(habitsRaw ?? []).filter((h) => !h.archivedAt);
  const habitLogs = alive(habitLogsRaw ?? []);
  const habitShare = new Map<string, number>();
  if (habits.length > 0) {
    const doneByDate = new Map<string, Set<string>>();
    for (const l of habitLogs) {
      const habit = habits.find((h) => h.id === l.habitId);
      if (!habit || !isLogDone(habit, l.value)) continue;
      const set = doneByDate.get(l.date);
      if (set) set.add(l.habitId);
      else doneByDate.set(l.date, new Set([l.habitId]));
    }
    for (const date of window) {
      const planned = habits.filter((h) => isActiveOn(h, date));
      if (planned.length === 0) continue;
      const done = doneByDate.get(date);
      const doneCount = done ? planned.filter((h) => done.has(h.id)).length : 0;
      habitShare.set(date, doneCount / planned.length);
    }
  }

  // Задачи: сколько закрыто в этот день. Знаменателя у задач нет (список
  // растёт и тает в течение дня), поэтому здесь честнее считать штуки.
  const closedPerDay = new Map<string, number>();
  for (const date of window) closedPerDay.set(date, 0);
  for (const task of alive(tasksRaw ?? [])) {
    if (!task.completedAt) continue;
    const date = task.completedAt.slice(0, 10);
    const prev = closedPerDay.get(date);
    if (prev !== undefined) closedPerDay.set(date, prev + 1);
  }

  return {
    habitSplit: splitByLevel(byDate, habitShare),
    taskSplit: splitByLevel(byDate, closedPerDay),
  };
}
