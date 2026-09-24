import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Напоминания ходят в воркер — в юните их не нужно.
vi.mock('../../lib/push', () => ({
  scheduleReminder: vi.fn(async () => {}),
  cancelReminder: vi.fn(async () => {}),
}));

import { db } from '../../db/db';
import { create } from '../../db/repo';
import { scheduleReminder } from '../../lib/push';
import type { Task } from '../../db/types';
import { toggleTask } from './taskActions';

const { reminderFireAt } = await vi.importActual<typeof import('../../lib/push')>('../../lib/push');

describe('повторяющаяся задача: отметить и снять отметку', () => {
  beforeEach(async () => {
    await db.tasks.clear();
  });

  it('снятие отметки убирает созданный повтор — в базе снова одна задача', async () => {
    const task = await create(db.tasks, {
      title: 'Полить цветы',
      notes: '',
      projectId: null,
      goalId: null,
      priority: 0,
      dueDate: '2026-09-13',
      dueTime: null,
      duration: null,
      remindBefore: null,
      completedAt: null,
      checklist: [],
      recurrence: { type: 'weekly', interval: 1, weekdays: [7] },
      tags: [],
      sortOrder: 1000,
    });
    await toggleTask(task);
    const afterDone = (await db.tasks.toArray()).filter((t) => !t.deletedAt);
    expect(afterDone).toHaveLength(2);
    const done = afterDone.find((t) => t.id === task.id)!;
    expect(done.spawnedId).toBe(afterDone.find((t) => t.id !== task.id)!.id);

    await toggleTask(done);
    const afterUndo = (await db.tasks.toArray()).filter((t) => !t.deletedAt);
    expect(afterUndo).toHaveLength(1);
    expect(afterUndo[0].id).toBe(task.id);
    expect(afterUndo[0].completedAt).toBeNull();
    expect(afterUndo[0].spawnedId).toBeNull();
  });

  it('правленный повтор (название изменили) при снятии отметки остаётся', async () => {
    const task = await create(db.tasks, {
      title: 'Планёрка',
      notes: '',
      projectId: null,
      goalId: null,
      priority: 0,
      dueDate: '2026-09-13',
      dueTime: null,
      duration: null,
      remindBefore: null,
      completedAt: null,
      checklist: [],
      recurrence: { type: 'weekly', interval: 1, weekdays: [1] },
      tags: [],
      sortOrder: 1000,
    });
    await toggleTask(task);
    const done = (await db.tasks.get(task.id))!;
    await db.tasks.update(done.spawnedId!, { title: 'Планёрка (правка)', updatedAt: '2026-09-14T10:00:00.000Z' });
    await toggleTask(done);
    const alive = (await db.tasks.toArray()).filter((t) => !t.deletedAt);
    expect(alive).toHaveLength(2);
    expect(alive.find((t) => t.id === done.spawnedId)?.title).toBe('Планёрка (правка)');
  });

  it('повтор, который уже тронули (выполнили), при снятии отметки не трогается', async () => {
    const task = await create(db.tasks, {
      title: 'Отчёт',
      notes: '',
      projectId: null,
      goalId: null,
      priority: 0,
      dueDate: '2026-09-13',
      dueTime: null,
      duration: null,
      remindBefore: null,
      completedAt: null,
      checklist: [],
      recurrence: { type: 'daily', interval: 1 },
      tags: [],
      sortOrder: 1000,
    });
    await toggleTask(task);
    const done = (await db.tasks.get(task.id))!;
    await db.tasks.update(done.spawnedId!, { completedAt: '2026-09-14T10:00:00.000Z' });
    await toggleTask(done);
    const alive = (await db.tasks.toArray()).filter((t) => !t.deletedAt);
    expect(alive).toHaveLength(2);
  });
});

// «Каждый месяц 10-го» с напоминанием за 30 минут. Раньше число повтора в
// новой задаче по умолчанию было 1-м, и следующий раз вместе с напоминанием
// уезжал на 1-е. Форма теперь берёт число из срока; здесь проверяется вторая
// половина цепочки — что после отметки напоминание ставится на следующее
// 10-е, в то же время, и при отметке в срок, и с опозданием.
describe('ежемесячный повтор: напоминание следующего раза', () => {
  const monthlyOn10 = () =>
    create(db.tasks, {
      title: 'Оплатить интернет',
      notes: '',
      projectId: null,
      goalId: null,
      priority: 0,
      dueDate: '2026-10-10',
      dueTime: '09:00',
      duration: null,
      remindBefore: 30,
      completedAt: null,
      checklist: [],
      recurrence: { type: 'monthly', interval: 1, dayOfMonth: 10 },
      tags: [],
      sortOrder: 1000,
    });

  beforeEach(async () => {
    await db.tasks.clear();
    vi.mocked(scheduleReminder).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const [when, today] of [
    ['в срок', '2026-10-10T08:00:00'],
    ['с опозданием на день', '2026-10-11T12:00:00'],
    ['с опозданием на три недели', '2026-10-31T12:00:00'],
  ] as const) {
    it(`отмечена ${when} — напоминание на 10 ноября в 8:30`, async () => {
      // Подменяем только Date: таймеры fake-indexeddb должны идти как есть.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(today));
      await toggleTask(await monthlyOn10());

      expect(scheduleReminder).toHaveBeenCalledTimes(1);
      const next = vi.mocked(scheduleReminder).mock.calls[0][0] as Task;
      expect(next.dueDate).toBe('2026-11-10');
      expect(next.dueTime).toBe('09:00');
      expect(next.remindBefore).toBe(30);
      expect(reminderFireAt(next)).toBe(new Date('2026-11-10T08:30:00').getTime());
    });
  }
});
