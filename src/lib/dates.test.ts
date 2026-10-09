import { afterEach, describe, expect, it } from 'vitest';
import { formatDayRange } from './dates';
import { setLang } from './i18n';

// Окно прогноза цикла (predict.ts: predictedStart ∓ d80) легко пересекает
// границу месяца, а функция считала оба конца одним месяцем: на «Сегодня»
// выходило «26–7 сентября» / «August 26–7».
describe('formatDayRange', () => {
  afterEach(() => setLang('ru'));

  it('ru: один месяц, граница месяца, граница года', () => {
    expect(formatDayRange('2026-08-10', '2026-08-25')).toBe('10–25 августа');
    expect(formatDayRange('2026-08-26', '2026-09-07')).toBe('26 августа–7 сентября');
    expect(formatDayRange('2026-12-28', '2027-01-03')).toBe('28 декабря–3 января');
    // Год и длиннее — без годов вышло бы «10 августа–25 августа».
    expect(formatDayRange('2026-08-10', '2027-08-25')).toBe('10 августа 2026–25 августа 2027');
    expect(formatDayRange('2026-09-07', '2026-09-07')).toBe('7 сентября');
  });

  it('en: один месяц, граница месяца, граница года', () => {
    setLang('en');
    expect(formatDayRange('2026-08-10', '2026-08-25')).toBe('August 10–25');
    expect(formatDayRange('2026-08-26', '2026-09-07')).toBe('August 26–September 7');
    expect(formatDayRange('2026-12-28', '2027-01-03')).toBe('December 28–January 3');
    expect(formatDayRange('2026-08-10', '2027-08-25')).toBe('August 10, 2026–August 25, 2027');
    expect(formatDayRange('2026-09-07', '2026-09-07')).toBe('September 7');
  });

  it('с годом (отчёт для врача): общий год один раз в конце', () => {
    expect(formatDayRange('2026-08-10', '2026-08-25', { year: true })).toBe('10–25 августа 2026');
    expect(formatDayRange('2026-03-03', '2026-06-02', { year: true })).toBe('3 марта–2 июня 2026');
    expect(formatDayRange('2025-12-28', '2026-01-03', { year: true })).toBe('28 декабря 2025–3 января 2026');
    expect(formatDayRange('2026-08-25', '2026-08-25', { year: true })).toBe('25 августа 2026');
    setLang('en');
    expect(formatDayRange('2026-08-10', '2026-08-25', { year: true })).toBe('August 10–25, 2026');
    expect(formatDayRange('2026-03-03', '2026-06-02', { year: true })).toBe('March 3–June 2, 2026');
  });

  it('узкая строка (неделя в «Спорте»): сокращаются только два месяца', () => {
    expect(formatDayRange('2026-09-07', '2026-09-13', { short: true })).toBe('7–13 сентября');
    expect(formatDayRange('2026-09-28', '2026-10-04', { short: true })).toBe('28 сент.–4 окт.');
    expect(formatDayRange('2026-12-28', '2027-01-03', { short: true })).toBe('28 дек.–3 янв.');
    setLang('en');
    expect(formatDayRange('2026-09-28', '2026-10-04', { short: true })).toBe('Sep 28–Oct 4');
  });
});
