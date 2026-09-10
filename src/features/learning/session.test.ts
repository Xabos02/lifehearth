import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { alive, create } from '../../db/repo';
import type { LearningItem } from '../../db/types';
import { logSession } from './session';

// Занятия за один день складываются, а не заменяют друг друга.
//
// Это то место, где тихая ошибка стоит дороже всего: заменяющая запись съела
// бы половину рабочего дня, а заметить это можно было бы только через неделю
// по осевшему темпу — и списать на себя, а не на приложение.

async function seedItem(): Promise<LearningItem> {
  return create(db.learningItems, {
    title: 'МВА',
    author: '',
    kind: 'course',
    status: 'inProgress',
    goalId: null,
    progressUnit: 'hours',
    progressTarget: 350,
    progressCurrent: 12,
    notes: '',
    startedAt: null,
    finishedAt: null,
    dueDate: '2027-03-05',
  });
}

const logsOf = async (itemId: string) =>
  alive(await db.learningLogs.where('itemId').equals(itemId).toArray());

describe('запись занятия', () => {
  beforeEach(async () => {
    await db.learningLogs.clear();
    await db.learningItems.clear();
  });

  it('первая запись за день создаётся', async () => {
    const item = await seedItem();
    await logSession(item, 90, 'Тема 6', '2026-09-11');
    const logs = await logsOf(item.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].minutes).toBe(90);
    expect(logs[0].note).toBe('Тема 6');
  });

  it('вторая запись за тот же день прибавляется к первой', async () => {
    const item = await seedItem();
    await logSession(item, 60, 'Утро', '2026-09-11');
    await logSession(item, 120, '', '2026-09-11');
    const logs = await logsOf(item.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].minutes).toBe(180);
  });

  it('пустая заметка не затирает прежнюю', async () => {
    const item = await seedItem();
    await logSession(item, 60, 'Лекция 5', '2026-09-11');
    await logSession(item, 30, '   ', '2026-09-11');
    expect((await logsOf(item.id))[0].note).toBe('Лекция 5');
  });

  it('новая заметка заменяет прежнюю', async () => {
    const item = await seedItem();
    await logSession(item, 60, 'Лекция 5', '2026-09-11');
    await logSession(item, 30, 'Лекция 6', '2026-09-11');
    expect((await logsOf(item.id))[0].note).toBe('Лекция 6');
  });

  it('разные дни — разные записи', async () => {
    const item = await seedItem();
    await logSession(item, 60, '', '2026-09-10');
    await logSession(item, 60, '', '2026-09-11');
    expect(await logsOf(item.id)).toHaveLength(2);
  });

  it('запись хранит прогресс материала на этот день', async () => {
    const item = await seedItem();
    await logSession(item, 60, '', '2026-09-11');
    expect((await logsOf(item.id))[0].value).toBe(12);
  });

  it('нулевое и отрицательное время не записывается', async () => {
    const item = await seedItem();
    await logSession(item, 0, '', '2026-09-11');
    await logSession(item, -30, '', '2026-09-11');
    await logSession(item, Number.NaN, '', '2026-09-11');
    expect(await logsOf(item.id)).toHaveLength(0);
  });

  it('удалённая запись за тот же день не мешает создать новую', async () => {
    const item = await seedItem();
    await logSession(item, 60, '', '2026-09-11');
    const [log] = await logsOf(item.id);
    await db.learningLogs.update(log.id, { deletedAt: new Date().toISOString() });
    await logSession(item, 45, '', '2026-09-11');
    const live = await logsOf(item.id);
    expect(live).toHaveLength(1);
    expect(live[0].minutes).toBe(45);
  });
});
