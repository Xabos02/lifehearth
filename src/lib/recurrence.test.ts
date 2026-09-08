import { afterEach, describe, expect, it } from 'vitest';
import { describeRecurrence } from './recurrence';
import { setLang } from './i18n';

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
