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

/** Порядок «день месяц» зависит от языка: по-русски «18 июня», по-английски
 *  «June 18». Локаль date-fns знает порядок только для своих шаблонов (PPP),
 *  а фиксированный 'd MMMM' её обходил — английский интерфейс показывал
 *  «18 June», при том что ввод («June 15» в быстром добавлении) читал
 *  наоборот. */
export function dayMonthFormat(): string {
  return getLang() === 'ru' ? 'd MMMM' : 'MMMM d';
}

/** Диапазон дат — единственное оформление на всё приложение (PROTOCOL §7.5,
 *  §7.7): тире «–» без пробелов, общее не повторяется.
 *  - один месяц: «10–25 августа» / «August 10–25»;
 *  - граница месяца: «26 августа–7 сентября» / «August 26–September 7».
 *    Сжать начало до числа тут нельзя: «26–7 сентября» читается как опечатка
 *    (так было на «Сегодня» у окна прогноза цикла);
 *  - граница года: «28 декабря–3 января» — без года, как и одиночные даты в
 *    приложении: диапазон короче года читается вперёд однозначно. Год и
 *    длиннее — годы у обоих концов, иначе «10 августа–25 августа» врёт.
 *  `year` — год всегда (отчёт для врача): «10–25 августа 2026» / «August
 *  10–25, 2026». `short` — для узкой строки: два названия месяца сокращаются
 *  («28 сент.–4 окт.»), одно остаётся полным.
 *  Intl.DateTimeFormat#formatRange не берём: тире с пробелами, и вывод
 *  зависит от версии ICU в браузере. */
export function formatDayRange(
  fromKeyStr: string,
  toKeyStr: string,
  opts: { year?: boolean; short?: boolean } = {},
): string {
  const ru = getLang() === 'ru';
  const fmt = (month: string, year: boolean) =>
    ru ? `d ${month}${year ? ' yyyy' : ''}` : `${month} d${year ? ', yyyy' : ''}`;
  const year = !!opts.year;
  if (fromKeyStr === toKeyStr) return formatRu(toKeyStr, fmt('MMMM', year));
  if (fromKeyStr.slice(0, 7) === toKeyStr.slice(0, 7)) {
    return ru
      ? `${formatRu(fromKeyStr, 'd')}–${formatRu(toKeyStr, fmt('MMMM', year))}`
      : `${formatRu(fromKeyStr, 'MMMM d')}–${formatRu(toKeyStr, year ? 'd, yyyy' : 'd')}`;
  }
  const month = opts.short ? 'MMM' : 'MMMM';
  const yearOrLonger = toKeyStr >= `${Number(fromKeyStr.slice(0, 4)) + 1}${fromKeyStr.slice(4)}`;
  const bothYears = fromKeyStr.slice(0, 4) !== toKeyStr.slice(0, 4) && (year || yearOrLonger);
  return `${formatRu(fromKeyStr, fmt(month, bothYears))}–${formatRu(toKeyStr, fmt(month, year || bothYears))}`;
}

/** «11 июня» / «June 11»; с явным fmt — как задано. */
export function formatRu(key: string, fmt?: string): string {
  return format(fromKey(key), fmt ?? dayMonthFormat(), { locale: dateLocale() });
}

/** Заголовок «Сегодня»: «Четверг, 12 июня» / «Thursday, June 12». */
export function formatHeaderDate(d: Date = new Date()): string {
  const s = format(d, getLang() === 'ru' ? 'EEEE, d MMMM' : 'EEEE, MMMM d', { locale: dateLocale() });
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
