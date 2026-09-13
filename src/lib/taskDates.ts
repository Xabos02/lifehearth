// Срок-период задачи («сдать с 10 по 25»): попадание дня в окно, подпись
// диапазона и перенос окна при повторении. Чистые функции над строками дат.

import { differenceInCalendarDays } from 'date-fns';
import type { Task } from '../db/types';
import { addDaysKey, formatDayRange, formatDueDate, formatRu, fromKey } from './dates';

/** Актуальна ли задача в этот день: точечный срок — ровно в свой день,
 *  период — каждый день окна включительно. Этим предикатом живут «Сегодня»
 *  и список дня в календаре. */
export function taskOnDay(
  t: Pick<Task, 'dueDate' | 'startDate'>,
  dayKey: string,
): boolean {
  if (!t.dueDate) return false;
  if (!t.startDate) return t.dueDate === dayKey;
  return t.startDate <= dayKey && dayKey <= t.dueDate;
}

/** Подпись срока-периода: «10–25 августа» в одном месяце, «28 августа —
 *  3 сентября» через границу. Дедлайн со словом («Сегодня», «Завтра»)
 *  оставляем словом — «10 августа – Завтра» читается лучше даты,
 *  до которой ещё надо посчитать дни. */
export function formatDueRange(startKey: string, dueKey: string): string {
  if (startKey === dueKey) return formatDueDate(dueKey);
  const due = formatDueDate(dueKey);
  // Дедлайн словом («Сегодня», «Tomorrow»), а не датой: сравниваем с тем,
  // что дала бы просто дата. Проверка «начинается с буквы» тут не годится —
  // по-английски и дата начинается с буквы («August 25»).
  const wordDue = due !== formatRu(dueKey);
  const sameMonth = startKey.slice(0, 7) === dueKey.slice(0, 7);
  if (!wordDue && sameMonth) return formatDayRange(startKey, dueKey);
  return `${formatRu(startKey)} — ${due}`;
}

/** Окно следующего повторения: дедлайн считает nextOccurrence, начало едет
 *  за ним на ту же длину окна. «Каждый месяц с 10 по 25»: длина 15 дней
 *  сохраняется, старт в коротком феврале сползёт на день-два — честная цена
 *  простоты против собственного календаря окон. */
export function nextWindowStart(
  startKey: string,
  dueKey: string,
  nextDueKey: string,
): string {
  const span = differenceInCalendarDays(fromKey(dueKey), fromKey(startKey));
  return addDaysKey(nextDueKey, -Math.max(0, span));
}
