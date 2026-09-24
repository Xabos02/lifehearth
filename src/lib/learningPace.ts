import { differenceInCalendarDays } from 'date-fns';
import type { LearningItem } from '../db/types';
import { fromKey, todayKey } from './dates';
import { t, tPlural } from './i18n';

/** Модель прогресса обучения: успеваю ли к сроку, сколько нагонять и что
 *  значит отметка плана.
 *
 *  Прогресс — число в единице материала: страницы, уроки, часы или проценты.
 *  Арифметике графика единица безразлична, там безразмерные числа. Единица
 *  важна ровно в трёх местах, и все три живут здесь, а не по экранам: когда
 *  каждый экран решал сам, вышло пять расхождений сразу (сквозной прогон,
 *  17.09):
 *  - план → прогресс (`planProgress`, `editedPlan`): у процентов шкала всегда
 *    100, а то, что человек поправил руками, план не перезаписывает;
 *  - прогноз финиша (`forecastPerWeek`): занятия пишутся в часах, поэтому
 *    темп по ним годится только материалу в часах;
 *  - подпись единицы (`unitLabel`): «1 урок», «5 уроков».
 *
 *  Весь расчёт идёт по календарным ключам 'YYYY-MM-DD' (см. dates.ts), а не по
 *  Date с временем: срок — это день, а не момент, и отметка в 23:30 не должна
 *  сдвигать остаток на сутки. */

export type ProgressUnit = LearningItem['progressUnit'];

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
  /** Сколько нужно сделать за ближайшие семь дней, чтобы успеть к сроку. */
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

  // Горизонт — не меньше недели. Было «не меньше дня»: остаток делился на
  // дни до срока и умножался на семь, и за день до срока шесть уроков
  // превращались в «42 урока в неделю» — больше, чем осталось вообще. Когда до
  // срока меньше недели или он прошёл, норма на ближайшие семь дней — весь
  // остаток; заодно нет деления на ноль в день срока.
  const weeksLeft = Math.max(daysLeft, WEEK) / WEEK;
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

/** Темп для прогноза финиша — в единицах самого материала.
 *
 *  Было: остаток в единицах материала делился на часы занятий, и курс в уроках
 *  получал «финиш» из «15 уроков ÷ 1 ч в неделю». Занятия пишутся в часах,
 *  поэтому темп по ним годится только материалу в часах. Страницы, уроки и
 *  проценты идут по прогрессу с начала материала — это продолжение сплошной
 *  линии «факт» на графике, который человек видит тут же.
 *  ponytail: среднее с начала, а не за 28 дней — у отметок прогресса нет
 *  надёжной истории (отметка плана лога не пишет); прогрессу, внесённому
 *  задним числом в первый день, прогноз первые недели льстит. */
export function forecastPerWeek(
  unit: ProgressUnit,
  current: number,
  from: string,
  logs: { date: string; minutes?: number }[],
  today = todayKey(),
): number {
  if (unit === 'hours') return recentPace(logs, 28, today) / 60;
  if (current <= 0) return 0;
  const days = differenceInCalendarDays(fromKey(today), fromKey(from));
  return (current / Math.max(1, days)) * WEEK;
}

type PlanPart = { estimate: number; doneAt: string | null };

/** Что отметки плана значат для прогресса материала; null — плана нет.
 *
 *  Часть весит своей оценкой, а если оценок в плане нет — все части весят
 *  поровну. Было: прогресс = сумма оценок закрытых частей, и в плане без
 *  оценок любая отметка обнуляла прогресс — сумма нулей.
 *
 *  Прогресс — на шкале материала: цель отметка не трогает. Было (24.09, до
 *  выкатки): отметка ставила цель = сумма оценок, и курс на 350 ч с частичным
 *  планом на 16,7 ч после первой отметки становился курсом на 16,7 ч. Цель по
 *  оценкам ставит только правка плана (`editedPlan`). У процентов шкала всегда
 *  100, а оценки — только веса: было «цель = сумма», и после плана «3 + 5»
 *  материал в процентах жил на шкале из восьми. */
export function planProgress(
  unit: ProgressUnit,
  target: number,
  parts: readonly PlanPart[],
): { target: number; current: number } | null {
  if (parts.length === 0) return null;
  const sum = parts.reduce((s, p) => s + p.estimate, 0);
  const weight = (p: { estimate: number }) => (sum > 0 ? p.estimate : 1);
  const done = parts.filter((p) => p.doneAt).reduce((s, p) => s + weight(p), 0);
  const scale = unit === 'percent' ? 100 : target;
  // Оценки в единицах материала — прогресс и есть их сумма, без долей.
  if (unit !== 'percent' && sum > 0) return { target: scale, current: Math.min(scale, done) };
  const total = sum > 0 ? sum : parts.length;
  // Доля шкалы — целым: «113 стр.», «38%», а не «113,333». Не выше цели:
  // округление вверх при дробной цели дало бы «13 из 12,5 ч».
  return { target: scale, current: Math.min(scale, Math.round((scale * done) / total)) };
}

/** Цель и прогресс после правки плана; null — плана не осталось, материал не
 *  трогаем.
 *
 *  Цель — сумма оценок нового плана (иначе доля считалась бы от числа,
 *  когда-то введённого руками), без оценок — прежняя, у процентов — 100.
 *
 *  Прогресс план ведёт, только пока он из плана и выведен — совпадает с тем,
 *  что давали отметки до правки: тогда он следует за новыми оценками. Прогресс,
 *  добавленный руками (степпером между отметками или до первой отметки),
 *  правка плана не трогает. Было (24.09, до выкатки): при любой закрытой части
 *  сохранение ставило прогресс по плану, и переименование главы возвращало
 *  163 стр. к 113. */
export function editedPlan(
  item: Pick<LearningItem, 'progressUnit' | 'progressTarget' | 'progressCurrent'>,
  before: readonly PlanPart[],
  after: readonly PlanPart[],
): { target: number; current: number } | null {
  const sum = after.reduce((s, p) => s + p.estimate, 0);
  const next = planProgress(item.progressUnit, sum > 0 ? sum : item.progressTarget, after);
  if (!next) return null;
  const prev = planProgress(item.progressUnit, item.progressTarget, before);
  // С допуском: сумма дробных оценок зависит от порядка, в котором её сложили.
  const fromPlan = prev !== null && Math.abs(item.progressCurrent - prev.current) < 1e-6;
  return {
    target: next.target,
    current: fromPlan ? next.current : Math.min(item.progressCurrent, next.target),
  };
}

/** Подпись единицы после числа: «1 урок», «2 урока», «8,4 урока». Страницы,
 *  часы и проценты — сокращения и не склоняются. Было одно «уроков» на любое
 *  число: «1 уроков», «42 уроков в неделю». */
export function unitLabel(unit: ProgressUnit, n: number): string {
  switch (unit) {
    case 'percent':
      return '%';
    case 'pages':
      return t('стр.');
    case 'hours':
      return t('ч');
    case 'lessons':
      return tPlural(n, ['урок', 'урока', 'уроков']);
  }
}
