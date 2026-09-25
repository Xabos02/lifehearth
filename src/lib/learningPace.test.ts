import { describe, expect, it } from 'vitest';
import { setLang } from './i18n';
import {
  editedPlan,
  forecastPerWeek,
  pace,
  planProgress,
  recentPace,
  unitLabel,
  weeksAtPace,
  type PaceInput,
  type ProgressUnit,
} from './learningPace';

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
    expect(p.perWeek).toBe(60);
  });

  it('меньше недели до срока — норма на неделю не больше остатка', () => {
    // Случай прогона: 6 уроков за день до срока показывались как «42 урока в
    // неделю» — остаток ÷ 1 день × 7. Сделать за неделю больше, чем осталось,
    // нельзя: норма — весь остаток. И так же после срока.
    const lessons = { target: 20, current: 14 };
    expect(pace(input({ ...lessons, today: '2026-12-30' }))!.perWeek).toBe(6);
    expect(pace(input({ ...lessons, today: '2027-01-15' }))!.perWeek).toBe(6);
    // С неделей и больше — прежняя равномерная норма: 12 за 10 дней = 8,4.
    expect(pace(input({ ...lessons, current: 8, today: '2026-12-21' }))!.perWeek).toBeCloseTo(8.4, 5);
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

  it('темп прогноза — в единицах материала, а не в часах занятий', () => {
    // Случай прогона: у курса в уроках «финиш» считался как «15 уроков ÷ 1 ч в
    // неделю». Четыре часа занятий за 28 дней — это 1 ч в неделю, но не урок.
    const logs = [0, 7, 14, 21].map((d) => ({ date: `2026-09-${String(24 - d).padStart(2, '0')}`, minutes: 60 }));
    // Уроки: 5 за 28 дней с начала — 1,25 урока в неделю, часы не участвуют.
    expect(forecastPerWeek('lessons', 5, '2026-08-27', logs, '2026-09-24')).toBeCloseTo(1.25, 5);
    expect(forecastPerWeek('lessons', 5, '2026-08-27', [], '2026-09-24')).toBeCloseTo(1.25, 5);
    // Часы: сами занятия и есть прогресс — 1 ч в неделю.
    expect(forecastPerWeek('hours', 5, '2026-08-27', logs, '2026-09-24')).toBeCloseTo(1, 5);
    // Без прогресса прогноза нет, а не «никогда» числом.
    expect(forecastPerWeek('pages', 0, '2026-08-27', logs, '2026-09-24')).toBe(0);
  });
});

describe('план → прогресс', () => {
  const parts = (...xs: [number, boolean][]) =>
    xs.map(([estimate, done]) => ({ estimate, doneAt: done ? '2026-09-24' : null }));

  it('план без оценок: части весят поровну, отметка не обнуляет прогресс', () => {
    // Случай прогона: 40 стр. из 340, план из трёх глав без оценок, отметка
    // первой главы — прогресс 0 (сумма оценок закрытых — сумма нулей).
    expect(planProgress('pages', 340, parts([0, true], [0, false], [0, false]))).toEqual({
      target: 340,
      current: 113,
    });
    expect(planProgress('pages', 340, parts([0, true], [0, true], [0, true]))).toEqual({
      target: 340,
      current: 340,
    });
  });

  it('у процентов шкала остаётся 100, оценки — только веса', () => {
    // Случай прогона: план «3 + 5» у материала в процентах ставил цель 8, и
    // закрытая первая часть показывалась как «3%» вместо 38%.
    expect(planProgress('percent', 100, parts([3, true], [5, false]))).toEqual({
      target: 100,
      current: 38,
    });
    expect(planProgress('percent', 8, parts([3, true], [5, true]))).toEqual({ target: 100, current: 100 });
  });

  it('отметка двигает прогресс, а цель не трогает', () => {
    // Курс в часах: прогресс — часы закрытых дисциплин, без долей. Цель
    // остаётся прежней: курс на 350 ч с частичным планом на 16,7 ч после
    // первой же отметки становился курсом на 16,7 ч (регрессия 24.09) — цель,
    // поправленную руками после плана, отметка не меняет.
    const p = planProgress('hours', 350, parts([5.4, true], [7.1, false], [4.2, true]))!;
    expect(p.target).toBe(350);
    expect(p.current).toBeCloseTo(9.6, 5);
    // Цель меньше суммы оценок — прогресс за неё не выходит.
    expect(planProgress('pages', 300, parts([200, true], [140, true]))).toEqual({ target: 300, current: 300 });
  });

  it('округление доли не выводит прогресс за цель', () => {
    expect(planProgress('hours', 12.5, parts([0, true], [0, true]))).toEqual({ target: 12.5, current: 12.5 });
  });

  it('без плана прогресс не трогается', () => {
    expect(planProgress('pages', 340, [])).toBeNull();
  });
});

describe('правка плана', () => {
  const parts = (...xs: [number, boolean][]) =>
    xs.map(([estimate, done]) => ({ estimate, doneAt: done ? '2026-09-24' : null }));
  const item = (progressTarget: number, progressCurrent: number, progressUnit: ProgressUnit = 'pages') => ({
    progressUnit,
    progressTarget,
    progressCurrent,
  });

  it('оценки нового плана задают цель', () => {
    // Основной путь — курс в часах: цель — сумма часов плана.
    const p = editedPlan(item(350, 0, 'hours'), [], parts([5.4, false], [7.1, false], [4.2, false]))!;
    expect(p.target).toBeCloseTo(16.7, 5);
    expect(p.current).toBe(0);
  });

  it('прогресс, добавленный руками, правка плана не откатывает', () => {
    // Регрессия 24.09: книга 340 стр., закрыта глава 1 из 3 (113), степпером
    // дочитано до 163 — переименование главы возвращало 113.
    const plan = parts([0, true], [0, false], [0, false]);
    expect(editedPlan(item(340, 163), plan, plan)).toEqual({ target: 340, current: 163 });
    // Пока план ничего не закрыл, прогресс тоже ручной: 40 стр. не обнуляются.
    expect(editedPlan(item(340, 40), [], parts([0, false], [0, false]))).toEqual({ target: 340, current: 40 });
  });

  it('прогресс из плана следует за правкой оценок', () => {
    // 5,4 ч закрытой дисциплины — это и есть прогресс; оценку поправили на 6 —
    // прогресс 6, а не устаревшие 5,4 до следующей отметки.
    const before = parts([5.4, true], [7.1, false], [4.2, false]);
    const after = parts([6, true], [7.1, false], [4.2, false]);
    const p = editedPlan(item(16.7, 5.4, 'hours'), before, after)!;
    expect(p.target).toBeCloseTo(17.3, 5);
    expect(p.current).toBe(6);
  });

  it('цель, поправленная руками после плана, правка плана не трогает', () => {
    // Курс 350 ч, в план внесены три дисциплины на 16,7 ч; цель поправлена
    // руками. Переименование части раньше возвращало цель к 16,7.
    const plan = parts([5.4, true], [7.1, false], [4.2, false]);
    const p = editedPlan(item(350, 5.4, 'hours'), plan, plan)!;
    expect(p.target).toBe(350);
    expect(p.current).toBeCloseTo(5.4, 5);
  });

  it('план стёрт — материал не трогается', () => {
    expect(editedPlan(item(340, 40), parts([0, true]), [])).toBeNull();
  });
});

describe('подпись единицы', () => {
  it('уроки склоняются по числу, в том числе дробному', () => {
    expect(['1', '2', '5', '11', '21', '8.4'].map((n) => unitLabel('lessons', Number(n)))).toEqual([
      'урок',
      'урока',
      'уроков',
      'уроков',
      'урок',
      'урока',
    ]);
    expect([unitLabel('pages', 1), unitLabel('hours', 1), unitLabel('percent', 1)]).toEqual([
      'стр.',
      'ч',
      '%',
    ]);
  });

  it('по-английски — lesson / lessons', () => {
    setLang('en');
    try {
      expect([1, 2, 8.4].map((n) => unitLabel('lessons', n))).toEqual(['lesson', 'lessons', 'lessons']);
    } finally {
      setLang('ru');
    }
  });
});
