import { afterEach, describe, expect, it } from 'vitest';
import { formatDayRange, formatRangeToWord } from './dates';
import { setLang } from './i18n';

// «_» в ожиданиях — неразрывный пробел: перенос строки допустим только после
// тире, внутри дат и перед тире строка не рвётся.
const nb = (s: string) => s.replace(/_/g, '\u00A0');

// Окно прогноза цикла (predict.ts: predictedStart ∓ d80) легко пересекает
// границу месяца, а функция считала оба конца одним месяцем: на «Сегодня»
// выходило «26–7 сентября» / «August 26–7».
describe('formatDayRange', () => {
  afterEach(() => setLang('ru'));

  it('ru: один месяц, граница месяца, граница года', () => {
    expect(formatDayRange('2026-08-10', '2026-08-25')).toBe(nb('10–25_августа'));
    expect(formatDayRange('2026-08-26', '2026-09-07')).toBe(nb('26_августа_— 7_сентября'));
    expect(formatDayRange('2026-12-28', '2027-01-03')).toBe(nb('28_декабря_— 3_января'));
    // Год и длиннее — без годов вышло бы «10 августа — 25 августа».
    expect(formatDayRange('2026-08-10', '2027-08-25')).toBe(nb('10_августа_2026_— 25_августа_2027'));
    expect(formatDayRange('2026-09-07', '2026-09-07')).toBe(nb('7_сентября'));
  });

  it('en: один месяц, граница месяца, граница года', () => {
    setLang('en');
    expect(formatDayRange('2026-08-10', '2026-08-25')).toBe(nb('August_10–25'));
    expect(formatDayRange('2026-08-26', '2026-09-07')).toBe(nb('August_26–September_7'));
    expect(formatDayRange('2026-12-28', '2027-01-03')).toBe(nb('December_28–January_3'));
    expect(formatDayRange('2026-08-10', '2027-08-25')).toBe(nb('August_10,_2026–August_25,_2027'));
    expect(formatDayRange('2026-09-07', '2026-09-07')).toBe(nb('September_7'));
  });

  it('с годом (отчёт для врача): общий год один раз в конце', () => {
    expect(formatDayRange('2026-08-10', '2026-08-25', { year: true })).toBe(nb('10–25_августа_2026'));
    expect(formatDayRange('2026-03-03', '2026-06-02', { year: true })).toBe(nb('3_марта_— 2_июня_2026'));
    expect(formatDayRange('2025-12-28', '2026-01-03', { year: true })).toBe(nb('28_декабря_2025_— 3_января_2026'));
    expect(formatDayRange('2026-08-25', '2026-08-25', { year: true })).toBe(nb('25_августа_2026'));
    setLang('en');
    expect(formatDayRange('2026-08-10', '2026-08-25', { year: true })).toBe(nb('August_10–25,_2026'));
    expect(formatDayRange('2026-03-03', '2026-06-02', { year: true })).toBe(nb('March_3–June_2,_2026'));
  });

  it('узкая строка (неделя в «Спорте»): сокращаются только два месяца', () => {
    expect(formatDayRange('2026-09-07', '2026-09-13', { short: true })).toBe(nb('7–13_сентября'));
    expect(formatDayRange('2026-09-28', '2026-10-04', { short: true })).toBe(nb('28_сент._— 4_окт.'));
    expect(formatDayRange('2026-12-28', '2027-01-03', { short: true })).toBe(nb('28_дек._— 3_янв.'));
    setLang('en');
    expect(formatDayRange('2026-09-28', '2026-10-04', { short: true })).toBe(nb('Sep_28–Oct_4'));
  });

  it('конец словом: тот же перенос только после тире', () => {
    expect(formatRangeToWord('2026-08-10', 'Завтра')).toBe(nb('10_августа_— Завтра'));
    expect(formatRangeToWord('2026-03-03', 'продолжается', 'd MMMM yyyy')).toBe(nb('3_марта_2026_— продолжается'));
  });
});
