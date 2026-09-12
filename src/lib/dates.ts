import { addDays, endOfMonth, endOfWeek, format, getISODay, isSameMonth, parse, startOfDay, startOfMonth, startOfWeek } from 'date-fns';
import { enUS, ru } from 'date-fns/locale';
import { getLang, t } from './i18n';

/** Локаль дат следует за языком интерфейса. Единственная точка выбора. */
export function dateLocale() {
  return getLang() === 'ru' ? ru : enUS;
}

// Календарные даты в приложении — локальные строки 'YYYY-MM-DD'.
// Это исключает таймзонный баг: отметка в 23:30 МСК остаётся в своём дне.
export const DATE_KEY_FORMAT = 'yyyy-MM-dd';

export function toKey(d: Date): string {
  return format(d, DATE_KEY_FORMAT);
}

export function fromKey(key: string): Date {
  return startOfDay(parse(key, DATE_KEY_FORMAT, new Date()));
}

export function todayKey(): string {
  return toKey(new Date());
}

export function addDaysKey(key: string, days: number): string {
  return toKey(addDays(fromKey(key), days));
}

/** Понедельник недели, в которую входит дата. */
export function weekStartKey(key: string): string {
  return toKey(startOfWeek(fromKey(key), { weekStartsOn: 1 }));
}

/** Сетка месяца для календарей: полные недели с понедельника, ключ дня и
 *  «свой ли месяц». Шаг — addDays, а не +86 400 000 мс: в сутки перевода
 *  часов назад полночь + 24 ч — это 23:00 того же дня, и день попадал в сетку
 *  дважды, сдвигая весь хвост месяца на столбец (Берлин, октябрь). В Москве
 *  перевода нет, поэтому у владельца не воспроизводилось. */
export function monthGridKeys(anchor: string): { key: string; inMonth: boolean }[] {
  const first = startOfMonth(fromKey(anchor));
  const from = startOfWeek(first, { weekStartsOn: 1 });
  const to = endOfWeek(endOfMonth(first), { weekStartsOn: 1 });
  const days: { key: string; inMonth: boolean }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push({ key: toKey(d), inMonth: isSameMonth(d, first) });
  return days;
}

/** День недели по ISO: 1=Пн … 7=Вс (совпадает с индексом WEEKDAY_LABELS + 1). */
export function isoWeekday(key: string): number {
  return getISODay(fromKey(key));
}

/** «11 июня», «11 июня 2027» и т.п. */
export function formatRu(key: string, fmt = 'd MMMM'): string {
  return format(fromKey(key), fmt, { locale: dateLocale() });
}

/** Заголовок «Сегодня»: «Четверг, 12 июня». */
export function formatHeaderDate(d: Date = new Date()): string {
  const s = format(d, 'EEEE, d MMMM', { locale: dateLocale() });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const WEEKDAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']; // index = isoDay - 1

/** Человекочитаемая дата срока: Сегодня / Завтра / Вчера / «18 июня». */
export function formatDueDate(key: string): string {
  const today = todayKey();
  if (key === today) return t('Сегодня');
  if (key === addDaysKey(today, 1)) return t('Завтра');
  if (key === addDaysKey(today, -1)) return t('Вчера');
  return formatRu(key);
}
