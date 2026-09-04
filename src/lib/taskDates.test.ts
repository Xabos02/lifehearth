import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatDueRange, nextWindowStart, taskOnDay } from './taskDates';
import { addDaysKey, todayKey } from './dates';

describe('срок-период задачи', () => {
  // «Сегодня», «Завтра», «Вчера» подставляются относительно текущей даты, поэтому
  // календарь фиксируем. Иначе тест с захардкоженными датами краснеет ровно в те
  // дни, когда один из концов диапазона попадает в окно относительных слов —
  // «28 августа — 3 сентября» превращается в «28 августа — Вчера» 4 сентября.
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('точечный срок актуален ровно в свой день', () => {
    const t = { dueDate: '2026-08-25', startDate: null };
    expect(taskOnDay(t, '2026-08-25')).toBe(true);
    expect(taskOnDay(t, '2026-08-24')).toBe(false);
  });

  it('период актуален каждый день окна, включая края', () => {
    const t = { dueDate: '2026-08-25', startDate: '2026-08-10' };
    expect(taskOnDay(t, '2026-08-10')).toBe(true);
    expect(taskOnDay(t, '2026-08-17')).toBe(true);
    expect(taskOnDay(t, '2026-08-25')).toBe(true);
    expect(taskOnDay(t, '2026-08-09')).toBe(false);
    expect(taskOnDay(t, '2026-08-26')).toBe(false);
  });

  it('без срока задача не занимает ни одного дня', () => {
    expect(taskOnDay({ dueDate: null, startDate: null }, todayKey())).toBe(false);
  });

  it('диапазон в одном месяце сжимается: «10–25 августа»', () => {
    expect(formatDueRange('2026-08-10', '2026-08-25')).toBe('10–25 августа');
  });

  it('диапазон через месяц — оба конца целиком', () => {
    expect(formatDueRange('2026-08-28', '2026-09-03')).toBe('28 августа — 3 сентября');
  });

  it('дедлайн-слово остаётся словом', () => {
    const today = todayKey();
    const start = addDaysKey(today, -5);
    expect(formatDueRange(start, today).endsWith('Сегодня')).toBe(true);
  });

  it('вырожденный период схлопывается в обычную дату', () => {
    expect(formatDueRange('2026-08-25', '2026-08-25')).toBe('25 августа');
  });

  it('окно повторения сохраняет длину', () => {
    // «с 10 по 25 августа», следующий дедлайн 25 сентября → старт 10 сентября.
    expect(nextWindowStart('2026-08-10', '2026-08-25', '2026-09-25')).toBe('2026-09-10');
  });

  it('кривое окно (start после due) не уводит старт за дедлайн', () => {
    expect(nextWindowStart('2026-08-30', '2026-08-25', '2026-09-25')).toBe('2026-09-25');
  });
});
