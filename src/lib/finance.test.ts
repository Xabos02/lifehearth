import { describe, expect, it } from 'vitest';
import type { ExpenseItem } from '../db/types';
import { financeSummary } from './finance';

function item(p: Partial<ExpenseItem>): ExpenseItem {
  return {
    id: 'e', createdAt: '', updatedAt: '', deletedAt: null,
    title: '', amount: 1000, kind: 'expense', category: '', recurrence: 'monthly',
    dayOfMonth: null, notes: '', active: true, sortOrder: 0,
    ...p,
  };
}

describe('разбивка трат по категориям', () => {
  it('разовая трата не даёт строку «Прочее — 0 ₽»', () => {
    // Разовая в месячную нагрузку не входит — её вклад в месяц 0 ₽. Строку в
    // разбивке она при этом получала, и без категории карточка показывала
    // пустое «Прочее — 0 ₽» с нулевой полосой.
    const s = financeSummary([
      item({ id: 'a', category: 'Жильё', amount: 45000 }),
      item({ id: 'b', category: '', recurrence: 'oneoff', amount: 3000 }),
      item({ id: 'c', category: 'Еда', recurrence: 'oneoff', amount: 700 }),
    ]);
    expect(s.byCategory).toEqual([{ category: 'Жильё', amount: 45000 }]);
    expect(s.expense).toBe(45000);
  });
});
