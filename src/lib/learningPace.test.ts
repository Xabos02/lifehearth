import { describe, expect, it } from 'vitest';
import { pace, recentPace, weeksAtPace, type PaceInput } from './learningPace';

// Успеваю ли к сроку и сколько нагонять.
//
// Место тихое и обманчивое: ошибка в этой арифметике не видна глазом — человек
// просто видит спокойное «идёшь по графику» там, где на самом деле отстаёт на
// месяц. Поэтому проверяется прямо, а не через интерфейс.
//
// Все даты — календарные ключи, «сегодня» подставляется в тест явно: иначе
// тест начал бы падать в тот день, когда срок из будущего станет прошлым.

const input = (extra: Partial<PaceInput> = {}): PaceInput => ({
  target: 100,
  current: 0,
  from: '2026-01-01',
  due: '2026-12-31',
  today: '2026-01-01',
  ...extra,
});

describe('график обучения', () => {
  it('без срока графика нет', () => {
    expect(pace(input({ due: null }))).toBeNull();
  });

  it('без объёма графика нет', () => {
    expect(pace(input({ target: 0 }))).toBeNull();
  });

  it('в начале пути весь объём распределён по неделям до срока', () => {
    const p = pace(input())!;
    expect(p.remaining).toBe(100);
    expect(p.daysLeft).toBe(364);
    expect(p.perWeek).toBeCloseTo(100 / 52, 2);
    expect(p.planned).toBe(0);
    expect(p.debt).toBe(0);
    expect(p.onTrack).toBe(true);
  });

  it('на середине срока план — половина объёма', () => {
    const p = pace(input({ today: '2026-07-02' }))!;
    expect(p.planned).toBeCloseTo(50, 0);
  });

  it('отставание — это разрыв между планом и сделанным', () => {
    const p = pace(input({ today: '2026-07-02', current: 20 }))!;
    expect(p.debt).toBeCloseTo(30, 0);
    expect(p.onTrack).toBe(false);
  });

  it('опережение отдаётся отрицательным отставанием', () => {
    const p = pace(input({ today: '2026-07-02', current: 70 }))!;
    expect(p.debt).toBeCloseTo(-20, 0);
    expect(p.onTrack).toBe(true);
  });

  it('чем меньше остаётся времени, тем выше нужный темп', () => {
    const early = pace(input({ today: '2026-01-01' }))!;
    const late = pace(input({ today: '2026-12-01' }))!;
    expect(late.perWeek).toBeGreaterThan(early.perWeek);
  });

  it('в последний день срока темп не уходит в бесконечность', () => {
    const p = pace(input({ today: '2026-12-31', current: 40 }))!;
    expect(Number.isFinite(p.perWeek)).toBe(true);
    expect(p.perWeek).toBeCloseTo(60 * 7, 0);
  });

  it('просроченный материал помечается, пока не закрыт', () => {
    const p = pace(input({ today: '2027-02-01', current: 40 }))!;
    expect(p.overdue).toBe(true);
    expect(p.done).toBe(false);
  });

  it('закрытый материал не бывает просроченным и не требует темпа', () => {
    const p = pace(input({ today: '2027-02-01', current: 100 }))!;
    expect(p.done).toBe(true);
    expect(p.overdue).toBe(false);
    expect(p.remaining).toBe(0);
    expect(p.onTrack).toBe(true);
  });

  it('сделано больше плана — остаток не уходит в минус', () => {
    const p = pace(input({ current: 150 }))!;
    expect(p.remaining).toBe(0);
  });
});

describe('фактический темп', () => {
  const logs = [
    { date: '2026-09-10', minutes: 120 },
    { date: '2026-09-08', minutes: 60 },
    { date: '2026-09-01', minutes: 180 },
  ];

  it('складывает минуты за окно и приводит к неделе', () => {
    // 360 минут за 28 дней = 90 минут в неделю.
    expect(recentPace(logs, 28, '2026-09-10')).toBeCloseTo(90, 0);
  });

  it('старое за окно не берёт', () => {
    // Остаются только 10 и 8 сентября: 180 минут за 7 дней.
    expect(recentPace(logs, 7, '2026-09-10')).toBeCloseTo(180, 0);
  });

  it('будущие записи не считает', () => {
    expect(recentPace([{ date: '2026-09-20', minutes: 300 }], 28, '2026-09-10')).toBe(0);
  });

  it('запись без времени темпа не даёт', () => {
    expect(recentPace([{ date: '2026-09-10' }], 28, '2026-09-10')).toBe(0);
  });

  it('без записей темп нулевой, а не NaN', () => {
    expect(recentPace([], 28, '2026-09-10')).toBe(0);
  });
});

describe('прогноз', () => {
  it('при нулевом темпе прогноза нет', () => {
    expect(weeksAtPace(100, 0)).toBeNull();
  });

  it('закрытый материал — ноль недель', () => {
    expect(weeksAtPace(0, 5)).toBe(0);
  });

  it('остаток делится на недельный темп', () => {
    expect(weeksAtPace(100, 10)).toBe(10);
  });
});
