import { describe, expect, it } from 'vitest';
import type { Workout } from '../../db/types';
import {
  avgIntervalDays,
  byType,
  daysSinceLast,
  formatHours,
  lastSessionLead,
  lastWorkout,
  paceMinPerKm,
  todayAdvice,
  totals,
  weekProgress,
  weekStreak,
  weekWorkouts,
  withGoalChange,
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
    groupId: null,
    customLabel: null,
    customColor: null,
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
    // Среда: до конца недели пять дней, отдых цели не мешает.
    const WED = '2026-09-09';
    expect(todayAdvice([w('2026-09-09')], WED)).toBe('done');
    expect(todayAdvice([w('2026-09-08')], WED)).toBe('rest');
    expect(todayAdvice([w('2026-09-07')], WED)).toBe('train');
    expect(daysSinceLast([w('2026-09-01'), w('2026-09-08')], TODAY)).toBe(4);
  });

  it('конец недели: отдых, только если после него цель ещё достижима (аудит H7)', () => {
    // Суббота, сделан 1 день из 3, вчера была: без тренировки сегодня до
    // воскресенья остаётся один день на два недостающих — тренировка.
    expect(todayAdvice([w('2026-09-11')], TODAY, 3)).toBe('train');
    // Сделано 2 из 3: отдохнуть сегодня и закрыть неделю в воскресенье можно.
    expect(todayAdvice([w('2026-09-08'), w('2026-09-11')], TODAY, 3)).toBe('rest');
    // Воскресенье, 1 из 3: цель уже не закрыть ничем — ритм прежний, отдых.
    expect(todayAdvice([w('2026-09-12')], '2026-09-13', 3)).toBe('rest');
    // Воскресенье, 2 из 3: сегодня последний шанс.
    expect(todayAdvice([w('2026-09-09'), w('2026-09-12')], '2026-09-13', 3)).toBe('train');
    // Понедельник: вчерашнее воскресенье — прошлая неделя, впереди семь дней.
    expect(todayAdvice([w('2026-09-13')], '2026-09-14', 3)).toBe('rest');
  });

  it('новая запись — с первого вида последнего занятия', () => {
    const lead = w('2026-09-11', 'strength', 45, { groupId: 'g', createdAt: '2026-09-11T10:00:00.000Z' });
    const tail = w('2026-09-11', 'stretch', 20, { groupId: 'g', createdAt: '2026-09-11T10:00:00.001Z' });
    expect(lastWorkout([lead, tail], TODAY)?.type).toBe('stretch');
    expect(lastSessionLead([tail, lead], TODAY)?.type).toBe('strength');
    expect(lastSessionLead([w('2026-09-10', 'boxing')], TODAY)?.type).toBe('boxing');
    expect(lastSessionLead([], TODAY)).toBeNull();
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
    // Состав, а не число: окно «от сегодня» тоже дало бы два, но других дня.
    expect(weekWorkouts(list, TODAY).map((x) => x.date)).toEqual(['2026-09-07', '2026-09-13']);
    expect(weekWorkouts(list, '2026-09-07').map((x) => x.date)).toEqual(['2026-09-07', '2026-09-13']);
    expect(weekWorkouts(list, '2026-09-13').map((x) => x.date)).toEqual(['2026-09-07', '2026-09-13']);
  });

  it('при цели 5–7 «отдых» после вчерашней не предлагается', () => {
    const WED = '2026-09-09';
    expect(todayAdvice([w('2026-09-08')], WED, 4)).toBe('rest');
    expect(todayAdvice([w('2026-09-08')], WED, 5)).toBe('train');
    expect(todayAdvice([w('2026-09-09')], WED, 7)).toBe('done');
  });

  it('часы и темп для плиток и строк', () => {
    const tt = (s: string) => s;
    expect(formatHours(0, tt)).toBe('0 ч');
    expect(formatHours(200, tt)).toBe('3,3 ч');
    expect(formatHours(630, tt)).toBe('10,5 ч');
    expect(paceMinPerKm(30, 5.2)).toBe('5:46');
    expect(paceMinPerKm(25, 5)).toBe('5:00');
    expect(paceMinPerKm(30, null)).toBeNull();
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

  it('серия сверяет прошлые недели с целью, что действовала тогда (аудит H8)', () => {
    const past = [
      w('2026-08-24'), w('2026-08-26'), w('2026-08-28'),
      w('2026-08-31'), w('2026-09-02'), w('2026-09-04'),
    ];
    const now = [...past, w('2026-09-07'), w('2026-09-09'), w('2026-09-10'), w('2026-09-11')];
    // Цель подняли с 3 до 4 на этой неделе: прошлые две засчитаны по тройке.
    const raised = withGoalChange(undefined, '2026-09-07', 3, 4);
    expect(weekStreak(now, TODAY, 4, raised)).toBe(3);
    // Без истории — как раньше: все недели по нынешней цели.
    expect(weekStreak(now, TODAY, 4)).toBe(1);
    // Снижение цели не раздувает серию задним числом.
    const thin = [w('2026-08-31'), w('2026-09-07')];
    expect(weekStreak(thin, TODAY, 1, withGoalChange(undefined, '2026-09-07', 3, 1))).toBe(1);
    // Две правки за неделю — одна запись, последняя.
    const twice = withGoalChange(withGoalChange(undefined, '2026-09-07', 3, 4), '2026-09-07', 4, 5);
    expect(twice).toEqual([{ from: '', goal: 3 }, { from: '2026-09-07', goal: 5 }]);
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
