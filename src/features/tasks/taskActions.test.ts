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
import { isSleeping, launchTasks, skipTask, toggleTask } from './taskActions';
import { todayKey } from '../../lib/dates';

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

describe('ручной повтор: отметка усыпляет, запуск возвращает в работу', () => {
  beforeEach(async () => {
    await db.tasks.clear();
  });

  it('отметка не плодит копию, запуск ставит копию без срока, отметка уходит в историю', async () => {
    const task = await create(db.tasks, {
      title: 'Генеральная уборка',
      notes: '',
      projectId: null,
      goalId: null,
      priority: 0,
      dueDate: '2026-10-20',
      dueTime: '10:00',
      duration: null,
      remindBefore: 30,
      completedAt: null,
      checklist: [{ id: 'c1', text: 'Окна', done: true }],
      recurrence: { type: 'manual' },
      tags: [],
      sortOrder: 3000,
    });

    // Отметили: второй задачи нет, отмеченная спит на месте.
    expect(await toggleTask(task)).toBeNull();
    const alive = async () => (await db.tasks.toArray()).filter((t) => !t.deletedAt);
    expect(await alive()).toHaveLength(1);
    const asleep = (await db.tasks.get(task.id))!;
    expect(isSleeping(asleep)).toBe(true);

    // Запустили: свежая копия на том же месте, без срока и напоминания,
    // с чистым чеклистом; отмеченная больше не спит — она в истории.
    await launchTasks([asleep]);
    const [done, fresh] = [(await db.tasks.get(task.id))!, (await alive()).find((t) => t.id !== task.id)!];
    expect(done.completedAt).not.toBeNull();
    expect(isSleeping(done)).toBe(false);
    expect(done.spawnedId).toBe(fresh.id);
    expect(fresh).toMatchObject({
      completedAt: null,
      dueDate: null,
      dueTime: null,
      remindBefore: null,
      sortOrder: 3000,
      recurrence: { type: 'manual' },
    });
    expect(fresh.checklist.map((i) => i.done)).toEqual([false]);

    // Повторный запуск того же — ничего не делает.
    await launchTasks([done]);
    expect(await alive()).toHaveLength(2);

    // Промах: сняли отметку с истории — копия убирается, задача снова в работе.
    await toggleTask(done);
    const back = await alive();
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: task.id, completedAt: null, spawnedId: null });
  });

  it('замороженная отмеченная не спит, пропуск переносит на сегодня, а не к «повтору»', async () => {
    const base = {
      notes: '', projectId: null, goalId: null, priority: 0 as const, dueTime: null, duration: null,
      remindBefore: null, checklist: [], recurrence: { type: 'manual' as const }, tags: [], sortOrder: 1000,
    };
    const frozen = await create(db.tasks, { ...base, title: 'Помыть машину', dueDate: null, completedAt: '2026-10-20T10:00:00.000Z', frozenAt: '2026-10-19T10:00:00.000Z' });
    expect(isSleeping(frozen)).toBe(false);

    const overdue = await create(db.tasks, { ...base, title: 'Полить цветы', dueDate: '2026-10-01', completedAt: null });
    await skipTask(overdue);
    expect((await db.tasks.get(overdue.id))!.dueDate).toBe(todayKey());
  });

  it('двойной тап по ↻ со старым снимком задачи даёт одну копию', async () => {
    const asleep = await create(db.tasks, {
      title: 'Генеральная уборка', notes: '', projectId: null, goalId: null, priority: 0, dueDate: null,
      dueTime: null, duration: null, remindBefore: null, completedAt: '2026-10-20T10:00:00.000Z', checklist: [],
      recurrence: { type: 'manual' }, tags: [], sortOrder: 1000,
    });
    await Promise.all([launchTasks([asleep]), launchTasks([asleep])]);
    await launchTasks([asleep]); // снимок из рендера всё ещё «спит»
    expect((await db.tasks.toArray()).filter((t) => !t.deletedAt)).toHaveLength(2);
  });
});

