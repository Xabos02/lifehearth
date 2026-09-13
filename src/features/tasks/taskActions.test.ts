import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Напоминания ходят в воркер — в юните их не нужно.
vi.mock('../../lib/push', () => ({
  scheduleReminder: vi.fn(async () => {}),
  cancelReminder: vi.fn(async () => {}),
}));

import { db } from '../../db/db';
import { create } from '../../db/repo';
import { toggleTask } from './taskActions';

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
