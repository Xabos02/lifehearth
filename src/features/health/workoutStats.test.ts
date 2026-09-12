import { describe, expect, it } from 'vitest';
import type { Workout } from '../../db/types';
import {
  avgIntervalDays,
  byType,
  daysSinceLast,
  lastWorkout,
  todayAdvice,
  totals,
  weekProgress,
  weekStreak,
} from './workoutStats';

let n = 0;
function w(date: string, type: Workout['type'] = 'run', minutes = 30, extra: Partial<Workout> = {}): Workout {
  n++;
  return {
    id: `w${n}`,
    createdAt: `${date}T10:00:00.000Z`,
    updatedAt: `${date}T10:00:00.000Z`,
    deletedAt: null,
    date,
    type,
    minutes,
    distanceKm: null,
    effort: null,
    note: '',
    source: 'manual',
    ...extra,
  };
}

// 2026-09-12 — суббота; неделя 7–13 сентября.
const TODAY = '2026-09-12';

describe('последняя тренировка и ритм «через день»', () => {
  it('без записей — start, дней с последней нет', () => {
    expect(daysSinceLast([], TODAY)).toBeNull();
    expect(todayAdvice([], TODAY)).toBe('start');
  });

  it('сегодня уже была — done; вчера — rest; позавчера и раньше — train', () => {
    expect(todayAdvice([w('2026-09-12')], TODAY)).toBe('done');
    expect(todayAdvice([w('2026-09-11')], TODAY)).toBe('rest');
    expect(todayAdvice([w('2026-09-10')], TODAY)).toBe('train');
    expect(daysSinceLast([w('2026-09-01'), w('2026-09-08')], TODAY)).toBe(4);
  });

  it('запись на будущее не считается последней', () => {
    const last = lastWorkout([w('2026-09-10'), w('2026-09-20')], TODAY);
    expect(last?.date).toBe('2026-09-10');
  });
});

describe('цель недели — по дням, не по записям', () => {
  it('две тренировки в один день — один день к цели', () => {
    const list = [w('2026-09-07'), w('2026-09-07', 'boxing'), w('2026-09-09')];
    expect(weekProgress(list, TODAY, 3)).toEqual({ done: 2, goal: 3 });
  });

  it('неделя — с понедельника по воскресенье, соседние не попадают', () => {
    const list = [w('2026-09-06'), w('2026-09-07'), w('2026-09-13'), w('2026-09-14')];
    expect(weekProgress(list, TODAY, 3).done).toBe(2);
  });
});

describe('серия недель по цели', () => {
  it('текущая неделя входит, только если цель уже закрыта', () => {
    const past = [
      w('2026-08-24'), w('2026-08-26'), w('2026-08-28'), // неделя 24–30 авг: 3
      w('2026-08-31'), w('2026-09-02'), w('2026-09-04'), // 31 авг – 6 сен: 3
    ];
    // Текущая (7–13): пока 2 — серия считается с прошлой недели.
    expect(weekStreak([...past, w('2026-09-07'), w('2026-09-09')], TODAY, 3)).toBe(2);
    // Закрыли третий день — текущая входит.
    expect(weekStreak([...past, w('2026-09-07'), w('2026-09-09'), w('2026-09-11')], TODAY, 3)).toBe(3);
  });

  it('пропущенная неделя рвёт серию, пропущенный день — нет', () => {
    const list = [w('2026-08-24'), w('2026-08-26'), w('2026-08-28'), w('2026-09-07'), w('2026-09-09'), w('2026-09-11')];
    // 31 авг – 6 сен пустая → серия только текущая.
    expect(weekStreak(list, TODAY, 3)).toBe(1);
  });
});

describe('интервал, сводки', () => {
  it('средний интервал по уникальным дням', () => {
    const list = [w('2026-09-01'), w('2026-09-03'), w('2026-09-03', 'boxing'), w('2026-09-07')];
    expect(avgIntervalDays(list, '2026-09-01', '2026-09-30')).toBe(3);
    expect(avgIntervalDays([w('2026-09-01')], '2026-09-01', '2026-09-30')).toBeNull();
  });

  it('по видам — минуты, число, дистанция, по убыванию минут', () => {
    const list = [
      w('2026-09-01', 'run', 30, { distanceKm: 5 }),
      w('2026-09-03', 'run', 40, { distanceKm: 6.5 }),
      w('2026-09-05', 'strength', 50),
      w('2026-08-01', 'strength', 90), // вне периода
    ];
    expect(byType(list, '2026-09-01', '2026-09-30')).toEqual([
      { type: 'run', minutes: 70, count: 2, distanceKm: 11.5 },
      { type: 'strength', minutes: 50, count: 1, distanceKm: 0 },
    ]);
    expect(totals(list, '2026-09-01', '2026-09-30')).toEqual({ minutes: 120, count: 3 });
  });
});
