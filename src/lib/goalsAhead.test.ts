import { describe, expect, it } from 'vitest';
import type { Goal, Task } from '../db/types';
import { compareAhead, deadlineLabel, goalCardDeadline, remainingLabel } from './goalsAhead';

function goal(p: Partial<Goal>): Goal {
  return {
    id: 'g', createdAt: '', updatedAt: '', deletedAt: null,
    title: 'Цель', description: '', targetDate: null, status: 'active',
    progressMode: 'manual', progressManual: 0, targetValue: null, currentValue: null,
    unitLabel: '', color: '#5b7cfa', sortOrder: 0,
    ...p,
  };
}
function task(done: boolean, i = 0): Task {
  return {
    id: `t${i}`, createdAt: '', updatedAt: '', deletedAt: null,
    title: '', notes: '', projectId: null, goalId: 'g', priority: 0,
    dueDate: null, dueTime: null, duration: null, remindBefore: null,
    completedAt: done ? '2026-01-01T00:00:00.000Z' : null,
    checklist: [], recurrence: null, tags: [], sortOrder: 0,
  };
}

describe('что осталось до цели', () => {
  it('по задачам: число и слово согласованы', () => {
    // Первая версия печатала «Осталось 3 3 задачи»: plur уже включает число, а
    // рядом стояло ещё одно. Глазами такое ловится не всегда, тестом — сразу.
    const g = goal({ progressMode: 'tasks' });
    expect(remainingLabel(g, [task(true), task(false, 1), task(false, 2), task(false, 3)], 25))
      .toBe('Осталось 3 задачи');
    expect(remainingLabel(g, [task(false), ...Array.from({ length: 4 }, (_, i) => task(false, i + 1))], 0))
      .toBe('Осталось 5 задач');
    expect(remainingLabel(g, [task(true), task(false, 1)], 50)).toBe('Осталось 1 задача');
  });

  it('цель по задачам без единой задачи объясняет, что делать', () => {
    // «Осталось 0 задач» при пустой цели читается как «всё сделано», хотя не
    // сделано ничего — прогресс просто не из чего считать.
    expect(remainingLabel(goal({ progressMode: 'tasks' }), [], 0)).toBe('Привяжите задачи');
  });

  it('числовая цель считает в своих единицах', () => {
    const g = goal({ progressMode: 'numeric', targetValue: 42, currentValue: 27, unitLabel: 'км' });
    expect(remainingLabel(g, [], 64)).toBe('Осталось 15 км');
  });

  it('перевыполненная числовая цель не уходит в минус', () => {
    const g = goal({ progressMode: 'numeric', targetValue: 10, currentValue: 14, unitLabel: 'книг' });
    expect(remainingLabel(g, [], 100)).toBe('Цель достигнута');
  });

  it('достигнутая цель — одна фраза для любого режима', () => {
    for (const mode of ['manual', 'numeric', 'tasks'] as const) {
      expect(remainingLabel(goal({ progressMode: mode }), [], 100)).toBe('Цель достигнута');
    }
  });
});

describe('подпись срока', () => {
  it('показывается только когда срок поджимает', () => {
    // Постоянное «осталось 214 дней» превращает срок в фон и глушит те случаи,
    // где он значит «пора».
    expect(deadlineLabel(214)).toBeNull();
    expect(deadlineLabel(7)).toBeNull();
    expect(deadlineLabel(6)).toEqual({ text: 'Осталось 6 дней', tone: 'warning' });
    expect(deadlineLabel(1)).toEqual({ text: 'Остался 1 день', tone: 'warning' });
    expect(deadlineLabel(2)).toEqual({ text: 'Осталось 2 дня', tone: 'warning' });
  });

  it('сегодня и просрочка — отдельные состояния', () => {
    expect(deadlineLabel(0)).toEqual({ text: 'Срок сегодня', tone: 'warning' });
    expect(deadlineLabel(-3)).toEqual({ text: 'Срок прошёл', tone: 'danger' });
  });

  it('без срока подписи нет', () => {
    expect(deadlineLabel(null)).toBeNull();
  });
});

describe('срок на карточке в «Целях»', () => {
  it('в день срока — «Срок сегодня», а не «Осталось 0 дней»', () => {
    // Ноль склоняется формой «много», и счётчик печатал «Осталось 0 дней» —
    // так не говорят, а лента над задачами в тот же день писала «Срок сегодня».
    expect(goalCardDeadline(goal({}), 0)).toEqual({ text: 'Срок сегодня', danger: true });
  });

  it('у завершённой и архивной цели срока нет, у цели в работе просрочка остаётся', () => {
    // Сквозной прогон 13–17.09: красная «Просрочена» у завершённой цели.
    expect(goalCardDeadline(goal({ status: 'completed' }), -14)).toBeNull();
    expect(goalCardDeadline(goal({ status: 'archived' }), -14)).toBeNull();
    expect(goalCardDeadline(goal({ status: 'active' }), -14)).toEqual({ text: 'Просрочена', danger: true });
    expect(goalCardDeadline(goal({ status: 'paused' }), -14)).toEqual({ text: 'Просрочена', danger: true });
  });
});

describe('порядок в ленте', () => {
  it('срочное впереди бессрочного, ближайшее впереди дальнего', () => {
    const list = [
      { days: null, value: 90 },
      { days: 30, value: 10 },
      { days: 2, value: 50 },
    ];
    expect([...list].sort(compareAhead)).toEqual([
      { days: 2, value: 50 },
      { days: 30, value: 10 },
      { days: null, value: 90 },
    ]);
  });

  it('среди бессрочных впереди то, что ближе к концу', () => {
    // Почти взятая цель подталкивает сильнее, чем едва начатая.
    const list = [
      { days: null, value: 12 },
      { days: null, value: 88 },
    ];
    expect([...list].sort(compareAhead)[0].value).toBe(88);
  });

  it('просроченное впереди всего — оно и есть самое срочное', () => {
    const list = [
      { days: 1, value: 0 },
      { days: -5, value: 0 },
    ];
    expect([...list].sort(compareAhead)[0].days).toBe(-5);
  });
});
