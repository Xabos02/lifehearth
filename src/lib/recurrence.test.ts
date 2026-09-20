import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeRecurrence, nextOccurrence } from './recurrence';
import { setLang } from './i18n';
import type { Recurrence } from '../db/types';

// Подпись повтора под задачей.
//
// Она собиралась приклеиванием префикса к готовой самостоятельной фразе, и это
// давало «Каждые 2 недели По Пн, Ср» — заглавную букву посреди предложения, —
// а без выбранных дней и вовсе «Каждые 2 недели Еженедельно»: прямое
// самопротиворечие. Ломалось в обоих языках, видно под каждой повторяющейся
// задачей, тестов у файла не было ни одного.
//
// Четыре случая недельного повтора — интервал один или больше, дни выбраны или
// нет — умножить на два языка. Именно их пересечение и было сломано.

afterEach(() => setLang('ru'));

const weekly = (interval: number, weekdays: number[]) =>
  describeRecurrence({ type: 'weekly', interval, weekdays });

describe('недельный повтор по-русски', () => {
  it('каждую неделю по дням', () => {
    expect(weekly(1, [1, 3])).toBe('По Пн, Ср');
  });

  it('каждую неделю без дней', () => {
    expect(weekly(1, [])).toBe('Еженедельно');
  });

  it('через неделю по дням — одной фразой, без заглавной в середине', () => {
    expect(weekly(2, [1, 3])).toBe('Каждые 2 недели по Пн, Ср');
  });

  it('через неделю без дней — без «Еженедельно» в хвосте', () => {
    expect(weekly(2, [])).toBe('Каждые 2 недели');
  });

  it('склонение считается, а не подставляется одним словом', () => {
    expect(weekly(5, [])).toBe('Каждые 5 недель');
    expect(weekly(21, [])).toBe('Каждую 21 неделю');
  });

  it('дни идут по порядку недели, а не в порядке выбора', () => {
    expect(weekly(1, [5, 1, 3])).toBe('По Пн, Ср, Пт');
  });
});

describe('недельный повтор по-английски', () => {
  it('каждую неделю по дням', () => {
    setLang('en');
    expect(weekly(1, [1, 3])).toBe('On Mon, Wed');
  });

  it('через неделю по дням', () => {
    setLang('en');
    expect(weekly(2, [1, 3])).toBe('Every 2 weeks on Mon, Wed');
  });

  it('через неделю без дней', () => {
    setLang('en');
    expect(weekly(3, [])).toBe('Every 3 weeks');
  });
});

describe('остальные виды повтора не задеты', () => {
  it('ежедневный', () => {
    expect(describeRecurrence({ type: 'daily', interval: 1 })).toBe('Каждый день');
    expect(describeRecurrence({ type: 'daily', interval: 3 })).toBe('Каждые 3 дня');
  });

  it('ежемесячный', () => {
    expect(describeRecurrence({ type: 'monthly', interval: 1, dayOfMonth: 5 })).toBe('5-го числа');
  });

  it('ежегодный', () => {
    expect(describeRecurrence({ type: 'yearly', interval: 1 })).toBe('Каждый год');
  });
});

// ──────────────────────────────────────────────────────────────────
// nextOccurrence — покрытие всех типов повтора, edge-cases, цепочки
// ──────────────────────────────────────────────────────────────────

function fakeToday(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${iso}T00:00:00`));
}

describe('nextOccurrence — daily', () => {
  afterEach(() => vi.useRealTimers());

  it('interval=1, выполнена в срок', () => {
    fakeToday('2026-09-10');
    expect(nextOccurrence({ type: 'daily', interval: 1 }, '2026-09-10')).toBe('2026-09-11');
  });

  it('interval=3', () => {
    fakeToday('2026-09-10');
    expect(nextOccurrence({ type: 'daily', interval: 3 }, '2026-09-10')).toBe('2026-09-13');
  });

  it('просроченная на 2 дня, interval=1', () => {
    fakeToday('2026-09-12');
    expect(nextOccurrence({ type: 'daily', interval: 1 }, '2026-09-10')).toBe('2026-09-13');
  });

  it('просроченная на 5 дней, interval=3 — кадэнс сохраняется', () => {
    fakeToday('2026-09-15');
    expect(nextOccurrence({ type: 'daily', interval: 3 }, '2026-09-10')).toBe('2026-09-16');
  });

  it('dueKey=null — от сегодня', () => {
    fakeToday('2026-09-10');
    expect(nextOccurrence({ type: 'daily', interval: 1 }, null)).toBe('2026-09-11');
  });
});

describe('nextOccurrence — weekly', () => {
  afterEach(() => vi.useRealTimers());

  it('без дней, interval=1', () => {
    fakeToday('2026-09-10');
    expect(nextOccurrence({ type: 'weekly', interval: 1, weekdays: [] }, '2026-09-10')).toBe('2026-09-17');
  });

  it('без дней, interval=2', () => {
    fakeToday('2026-09-10');
    expect(nextOccurrence({ type: 'weekly', interval: 2, weekdays: [] }, '2026-09-10')).toBe('2026-09-24');
  });

  it('Пн+Ср (1,3), выполнена в Ср — следующий Пн', () => {
    // 2026-09-09 = Ср
    fakeToday('2026-09-09');
    expect(nextOccurrence({ type: 'weekly', interval: 1, weekdays: [1, 3] }, '2026-09-09')).toBe('2026-09-14');
  });

  it('Пн+Пт (1,5), выполнена в Пн — следующий Пт той же недели', () => {
    // 2026-09-07 = Пн
    fakeToday('2026-09-07');
    expect(nextOccurrence({ type: 'weekly', interval: 1, weekdays: [1, 5] }, '2026-09-07')).toBe('2026-09-11');
  });

  it('просроченная на неделю, interval=1, weekdays=[1]', () => {
    // due Пн 7 сен, выполнена в Пн 14 сен
    fakeToday('2026-09-14');
    expect(nextOccurrence({ type: 'weekly', interval: 1, weekdays: [1] }, '2026-09-07')).toBe('2026-09-21');
  });
});

describe('nextOccurrence — monthly', () => {
  afterEach(() => vi.useRealTimers());

  it('10-е число, выполнена в срок', () => {
    fakeToday('2026-09-10');
    expect(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 10 }, '2026-09-10')).toBe('2026-10-10');
  });

  it('10-е число, выполнена на 2 дня позже — всё равно следующий месяц', () => {
    fakeToday('2026-09-12');
    expect(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 10 }, '2026-09-10')).toBe('2026-10-10');
  });

  it('10-е число, выполнена через месяц + 1 день — не перепрыгивает', () => {
    fakeToday('2026-10-11');
    expect(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 10 }, '2026-09-10')).toBe('2026-11-10');
  });

  it('31-е число: короткий месяц (февраль) → 28-е, затем март → 31-е', () => {
    fakeToday('2026-01-31');
    expect(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 31 }, '2026-01-31')).toBe('2026-02-28');
    fakeToday('2026-02-28');
    expect(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 31 }, '2026-02-28')).toBe('2026-03-31');
  });

  it('31-е число: апрель (30 дней) → 30-е', () => {
    fakeToday('2026-03-31');
    expect(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 31 }, '2026-03-31')).toBe('2026-04-30');
  });

  it('29 февраля високосного года', () => {
    fakeToday('2028-01-29');
    expect(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 29 }, '2028-01-29')).toBe('2028-02-29');
  });

  it('29-е число, не високосный год → 28 февраля', () => {
    fakeToday('2026-01-29');
    expect(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 29 }, '2026-01-29')).toBe('2026-02-28');
  });

  it('interval=2 (раз в 2 месяца)', () => {
    fakeToday('2026-09-10');
    expect(nextOccurrence({ type: 'monthly', interval: 2, dayOfMonth: 10 }, '2026-09-10')).toBe('2026-11-10');
  });

  it('interval=3, просрочка на 4 месяца — прыжок к ближайшему кадэнсному', () => {
    fakeToday('2027-01-15');
    expect(nextOccurrence({ type: 'monthly', interval: 3, dayOfMonth: 10 }, '2026-09-10')).toBe('2027-03-10');
  });

  it('dayOfMonth > day(anchor): не возвращает тот же месяц', () => {
    fakeToday('2026-09-05');
    expect(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 10 }, '2026-09-05')).toBe('2026-10-10');
  });

  it('dueKey=null — от сегодня', () => {
    fakeToday('2026-09-15');
    expect(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 15 }, null)).toBe('2026-10-15');
  });

  it('декабрь → январь следующего года', () => {
    fakeToday('2026-12-10');
    expect(nextOccurrence({ type: 'monthly', interval: 1, dayOfMonth: 10 }, '2026-12-10')).toBe('2027-01-10');
  });
});

describe('nextOccurrence — yearly', () => {
  afterEach(() => vi.useRealTimers());

  it('interval=1, выполнена в срок', () => {
    fakeToday('2026-09-10');
    expect(nextOccurrence({ type: 'yearly', interval: 1 }, '2026-09-10')).toBe('2027-09-10');
  });

  it('interval=2', () => {
    fakeToday('2026-09-10');
    expect(nextOccurrence({ type: 'yearly', interval: 2 }, '2026-09-10')).toBe('2028-09-10');
  });

  it('просроченная на год, interval=1', () => {
    fakeToday('2027-09-15');
    expect(nextOccurrence({ type: 'yearly', interval: 1 }, '2026-09-10')).toBe('2028-09-10');
  });

  it('29 февраля → 28 февраля в не-високосный год', () => {
    fakeToday('2028-02-29');
    expect(nextOccurrence({ type: 'yearly', interval: 1 }, '2028-02-29')).toBe('2029-02-28');
  });
});

// ──────────────────────────────────────────────────────────────────
// Многоуровневые симуляции цепочек повторений
// ──────────────────────────────────────────────────────────────────

describe('цепочка monthly: 12 месяцев, 10-е число, выполнение в срок', () => {
  afterEach(() => vi.useRealTimers());

  it('каждый месяц возвращает 10-е число', () => {
    const rec: Recurrence = { type: 'monthly', interval: 1, dayOfMonth: 10 };
    let dueKey = '2026-01-10';
    const expected = [
      '2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10',
      '2026-07-10', '2026-08-10', '2026-09-10', '2026-10-10', '2026-11-10',
      '2026-12-10', '2027-01-10',
    ];
    for (const exp of expected) {
      fakeToday(dueKey);
      const next = nextOccurrence(rec, dueKey);
      expect(next).toBe(exp);
      dueKey = next;
    }
  });
});

describe('цепочка monthly: 12 месяцев, 10-е число, выполнение с опозданием 3 дня', () => {
  afterEach(() => vi.useRealTimers());

  it('каждый месяц возвращает 10-е, несмотря на опоздание', () => {
    const rec: Recurrence = { type: 'monthly', interval: 1, dayOfMonth: 10 };
    let dueKey = '2026-01-10';
    const expected = [
      '2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10',
      '2026-07-10', '2026-08-10', '2026-09-10', '2026-10-10', '2026-11-10',
      '2026-12-10', '2027-01-10',
    ];
    for (const exp of expected) {
      fakeToday(dueKey.replace(/-10$/, '-13'));
      const next = nextOccurrence(rec, dueKey);
      expect(next).toBe(exp);
      dueKey = next;
    }
  });
});

describe('цепочка monthly: 31-е число через короткие месяцы', () => {
  afterEach(() => vi.useRealTimers());

  it('clamp в коротких месяцах, восстановление в длинных', () => {
    const rec: Recurrence = { type: 'monthly', interval: 1, dayOfMonth: 31 };
    const chain: [string, string][] = [
      ['2026-01-31', '2026-02-28'],
      ['2026-02-28', '2026-03-31'],
      ['2026-03-31', '2026-04-30'],
      ['2026-04-30', '2026-05-31'],
      ['2026-05-31', '2026-06-30'],
      ['2026-06-30', '2026-07-31'],
      ['2026-07-31', '2026-08-31'],
      ['2026-08-31', '2026-09-30'],
      ['2026-09-30', '2026-10-31'],
      ['2026-10-31', '2026-11-30'],
      ['2026-11-30', '2026-12-31'],
    ];
    for (const [due, exp] of chain) {
      fakeToday(due);
      expect(nextOccurrence(rec, due)).toBe(exp);
    }
  });
});

describe('цепочка monthly: interval=2, 15-е число, 6 шагов', () => {
  afterEach(() => vi.useRealTimers());

  it('шаг через 2 месяца сохраняет кадэнс', () => {
    const rec: Recurrence = { type: 'monthly', interval: 2, dayOfMonth: 15 };
    let dueKey = '2026-01-15';
    const expected = [
      '2026-03-15', '2026-05-15', '2026-07-15', '2026-09-15', '2026-11-15', '2027-01-15',
    ];
    for (const exp of expected) {
      fakeToday(dueKey);
      const next = nextOccurrence(rec, dueKey);
      expect(next).toBe(exp);
      dueKey = next;
    }
  });
});

describe('цепочка daily: interval=1, 7 дней', () => {
  afterEach(() => vi.useRealTimers());

  it('каждый день ровно +1', () => {
    const rec: Recurrence = { type: 'daily', interval: 1 };
    let dueKey = '2026-09-10';
    for (let i = 11; i <= 17; i++) {
      fakeToday(dueKey);
      const next = nextOccurrence(rec, dueKey);
      expect(next).toBe(`2026-09-${i}`);
      dueKey = next;
    }
  });
});

describe('цепочка weekly: Пн+Чт (1,4), 4 недели', () => {
  afterEach(() => vi.useRealTimers());

  it('чередование Пн и Чт', () => {
    const rec: Recurrence = { type: 'weekly', interval: 1, weekdays: [1, 4] };
    // 2026-09-07 = Пн
    let dueKey = '2026-09-07';
    const expected = [
      '2026-09-10', // Чт
      '2026-09-14', // Пн
      '2026-09-17', // Чт
      '2026-09-21', // Пн
      '2026-09-24', // Чт
      '2026-09-28', // Пн
      '2026-10-01', // Чт
    ];
    for (const exp of expected) {
      fakeToday(dueKey);
      const next = nextOccurrence(rec, dueKey);
      expect(next).toBe(exp);
      dueKey = next;
    }
  });
});
