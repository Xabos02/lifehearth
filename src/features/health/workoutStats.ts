import { addDaysKey, weekStartKey } from '../../lib/dates';
import type { Workout, WorkoutType } from '../../db/types';

// Чистые расчёты раздела «Спорт» — без React и без базы, чтобы гонять юнитами.
// На входе всегда список живых тренировок (deletedAt уже отфильтрован).

/** Сколько дней прошло с последней тренировки; null — тренировок нет. */
export function daysSinceLast(workouts: Workout[], today: string): number | null {
  const last = lastWorkout(workouts, today);
  if (!last) return null;
  return diffDays(last.date, today);
}

/** Последняя тренировка не позже сегодня (записи «на будущее» не считаются). */
export function lastWorkout(workouts: Workout[], today: string): Workout | null {
  let best: Workout | null = null;
  for (const w of workouts) {
    if (w.date > today) continue;
    if (!best || w.date > best.date || (w.date === best.date && w.createdAt > best.createdAt)) best = w;
  }
  return best;
}

/** Тренировки на неделе (понедельник — воскресенье), к которой относится день. */
export function weekWorkouts(workouts: Workout[], day: string): Workout[] {
  const start = weekStartKey(day);
  const end = addDaysKey(start, 6);
  return workouts.filter((w) => w.date >= start && w.date <= end);
}

/** Сделано дней с тренировками на неделе против цели. Считаются ДНИ, а не
 *  записи: две тренировки в один день — один день к цели, как в Apple Fitness
 *  («workout days»). Иначе цель «три в неделю» закрывалась бы одним днём с
 *  тремя короткими записями. */
export function weekProgress(workouts: Workout[], day: string, goal: number): { done: number; goal: number } {
  const days = new Set(weekWorkouts(workouts, day).map((w) => w.date));
  return { done: days.size, goal: Math.max(1, goal) };
}

export type TodayAdvice = 'done' | 'rest' | 'train' | 'start';

/** Что сегодня по ритму «через день».
 *
 *  Владелец: «стараюсь тренироваться через день, три раза в неделю». Значит:
 *  сегодня уже была — done; вчера была — rest; два дня и больше — train.
 *  Ни одной записи — start. Цель недели здесь не участвует: она про счёт,
 *  а ритм — про то, отдохнули ли мышцы. */
export function todayAdvice(workouts: Workout[], today: string): TodayAdvice {
  const since = daysSinceLast(workouts, today);
  if (since === null) return 'start';
  if (since === 0) return 'done';
  if (since === 1) return 'rest';
  return 'train';
}

/** Средний интервал между тренировочными днями за период, в днях; null —
 *  меньше двух дней с тренировками. Считается по уникальным дням. */
export function avgIntervalDays(workouts: Workout[], from: string, to: string): number | null {
  const days = [...new Set(workouts.filter((w) => w.date >= from && w.date <= to).map((w) => w.date))].sort();
  if (days.length < 2) return null;
  return diffDays(days[0], days[days.length - 1]) / (days.length - 1);
}

/** Серия недель подряд (включая текущую, если цель уже выполнена; иначе —
 *  начиная с прошлой), в которых цель по дням выполнена. Терпима к отдыху:
 *  считаются недели, а не дни, — пропущенный день серию не рвёт. */
export function weekStreak(workouts: Workout[], today: string, goal: number): number {
  let streak = 0;
  let cursor = weekStartKey(today);
  const current = weekProgress(workouts, today, goal);
  if (current.done < current.goal) cursor = addDaysKey(cursor, -7);
  for (let i = 0; i < 520; i++) {
    const p = weekProgress(workouts, cursor, goal);
    if (p.done < p.goal) break;
    streak++;
    cursor = addDaysKey(cursor, -7);
  }
  return streak;
}

/** Сводка по видам за период: минуты и число записей, по убыванию минут. */
export function byType(
  workouts: Workout[],
  from: string,
  to: string,
): { type: WorkoutType; minutes: number; count: number; distanceKm: number }[] {
  const acc = new Map<WorkoutType, { minutes: number; count: number; distanceKm: number }>();
  for (const w of workouts) {
    if (w.date < from || w.date > to) continue;
    const cur = acc.get(w.type) ?? { minutes: 0, count: 0, distanceKm: 0 };
    cur.minutes += w.minutes;
    cur.count += 1;
    cur.distanceKm += w.distanceKm ?? 0;
    acc.set(w.type, cur);
  }
  return [...acc.entries()]
    .map(([type, v]) => ({ type, ...v }))
    .sort((a, b) => b.minutes - a.minutes);
}

/** Сумма минут и число записей за период. */
export function totals(workouts: Workout[], from: string, to: string): { minutes: number; count: number } {
  let minutes = 0;
  let count = 0;
  for (const w of workouts) {
    if (w.date < from || w.date > to) continue;
    minutes += w.minutes;
    count += 1;
  }
  return { minutes, count };
}

/** «1 ч 25 м» / «45 мин» — короткая длительность для карточек. */
export function formatMinutes(min: number, t: (s: string) => string): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m} ${t('мин')}`;
  return m === 0 ? `${h} ${t('ч')}` : `${h} ${t('ч')} ${m} ${t('м')}`;
}

function diffDays(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}
