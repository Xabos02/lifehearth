import { differenceInCalendarDays } from 'date-fns';
import { fromKey, todayKey } from './dates';

/** Расчёт графика обучения: успеваю ли к сроку и сколько нагонять.
 *
 *  Единица намеренно не названа. Материал может считаться в часах, страницах,
 *  частях или процентах — арифметика графика от этого не меняется, поэтому
 *  здесь везде безразмерные числа, а «ч» или «стр.» подставляет интерфейс.
 *
 *  Весь расчёт идёт по календарным ключам 'YYYY-MM-DD' (см. dates.ts), а не по
 *  Date с временем: срок — это день, а не момент, и отметка в 23:30 не должна
 *  сдвигать остаток на сутки. */

export interface PaceInput {
  /** Сколько всего: страниц, частей, часов. */
  target: number;
  /** Сколько уже сделано в тех же единицах. */
  current: number;
  /** С какого дня считается план — начало материала. */
  from: string;
  /** Срок. Без него графика нет. */
  due: string | null;
  /** Подменяется в тестах. */
  today?: string;
}

export interface Pace {
  /** Сколько осталось сделать. */
  remaining: number;
  /** Календарных дней до срока; отрицательное — срок прошёл. */
  daysLeft: number;
  /** Сколько нужно в неделю, чтобы успеть к сроку. */
  perWeek: number;
  /** Сколько должно быть сделано к сегодняшнему дню по равномерному плану. */
  planned: number;
  /** Отставание: положительное — отстаёшь, отрицательное — идёшь с запасом. */
  debt: number;
  /** Идёшь по графику (отставание меньше суток работы). */
  onTrack: boolean;
  /** Срок прошёл, а материал не закрыт. */
  overdue: boolean;
  /** Материал закрыт. */
  done: boolean;
}

/** Дней в неделе — вынесено, чтобы не искать «7» по формулам. */
const WEEK = 7;

/** Сколько работы должно быть сделано к дате `on` при равномерном плане.
 *
 *  Равномерный план, а не «по темам»: приложение не знает, какие части
 *  тяжелее, а человек всё равно сравнивает себя с ровной линией. */
function plannedAt(target: number, from: string, due: string, on: string): number {
  const total = differenceInCalendarDays(fromKey(due), fromKey(from));
  if (total <= 0) return target;
  const gone = differenceInCalendarDays(fromKey(on), fromKey(from));
  const share = Math.min(1, Math.max(0, gone / total));
  return target * share;
}

/** График по материалу. Без срока (`due === null`) возвращает null —
 *  у такого материала есть прогресс, но нет ни темпа, ни отставания. */
export function pace(input: PaceInput): Pace | null {
  const { target, current, from, due } = input;
  if (!due || target <= 0) return null;

  const today = input.today ?? todayKey();
  const remaining = Math.max(0, target - current);
  const daysLeft = differenceInCalendarDays(fromKey(due), fromKey(today));
  const done = remaining === 0;

  // Срок сегодня или прошёл — всю оставшуюся работу считаем недельной нормой,
  // иначе деление на ноль дало бы Infinity в интерфейсе.
  const weeksLeft = Math.max(daysLeft, 1) / WEEK;
  const planned = plannedAt(target, from, due, today);
  const debt = planned - current;

  return {
    remaining,
    daysLeft,
    perWeek: remaining / weeksLeft,
    planned,
    debt,
    // Порог в один день работы: без него любое округление показывает
    // «отстаёшь на 0,3 ч» и предупреждение перестают замечать.
    onTrack: done || debt <= target / Math.max(1, differenceInCalendarDays(fromKey(due), fromKey(from))),
    overdue: !done && daysLeft < 0,
    done,
  };
}

/** Фактический темп: сколько минут в неделю человек занимался за последние
 *  `days` дней. Считается по записям занятий, а не по прогрессу: можно сидеть
 *  над материалом и не закрывать части — эти два числа расходятся, и именно
 *  расхождение показывает, что работа идёт не туда. */
export function recentPace(
  logs: { date: string; minutes?: number }[],
  days = 28,
  today = todayKey(),
): number {
  if (days <= 0) return 0;
  const spent = logs.reduce((sum, log) => {
    const ago = differenceInCalendarDays(fromKey(today), fromKey(log.date));
    return ago >= 0 && ago < days ? sum + (log.minutes ?? 0) : sum;
  }, 0);
  return (spent / days) * WEEK;
}

/** Через сколько недель материал закончится при текущем темпе.
 *  `null`, когда темпа нет — прогноз «никогда» лучше не показывать числом. */
export function weeksAtPace(remaining: number, perWeekActual: number): number | null {
  if (perWeekActual <= 0) return null;
  if (remaining <= 0) return 0;
  return remaining / perWeekActual;
}
