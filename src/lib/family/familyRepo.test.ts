import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Семейная задача: напоминание и порядок после каждой записи.
//
// Разбор работы 20.09 (задача 26). Напоминание ставилось и снималось прямо из
// кнопок экрана, и пути разошлись: снятая отметка «выполнена» снимала его и не
// возвращала (колокольчик в списке оставался), выполнение с телефона без
// уведомлений до сервера не доходило — автор получал напоминание о сделанном
// деле, а правка цвета или приоритета ставила его заново и на чужом телефоне
// забирала себе. Перенос строки переписывал все задачи группы, даже когда
// место не менялось. Здесь — то, что пишет репозиторий, через который идут
// все записи семейной задачи.

vi.mock('../push', () => ({
  scheduleReminder: vi.fn(async () => {}),
  cancelReminder: vi.fn(async () => {}),
}));
vi.mock('./familyChat', () => ({ sendItem: vi.fn(async () => true) }));

import { db } from '../../db/db';
import type { FamilyTask } from '../../db/types';
import { cancelReminder, scheduleReminder } from '../push';
import { sendItem } from './familyChat';
import {
  deleteFamilyTask,
  reorderFamilyTasks,
  toggleFamilyTask,
  updateFamilyTask,
} from './familyRepo';

const F = 'f1';

function task(id: string, over: Partial<FamilyTask> = {}): FamilyTask {
  return {
    id,
    familyId: F,
    seq: 5,
    title: `Задача ${id}`,
    notes: '',
    priority: 0,
    dueDate: '2099-01-10',
    dueTime: null,
    remindBefore: 1440,
    color: null,
    assigneeId: null,
    createdBy: 'me',
    completedAt: null,
    completedBy: null,
    sortOrder: 1000,
    deletedAt: null,
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await db.familyTasks.clear();
  await db.family.put({ id: F, familyId: F, selfMemberId: 'me' } as never);
});

describe('напоминание семейной задачи', () => {
  it('выполнение снимает его на сервере, даже без своей подписки', async () => {
    const t = task('a');
    await db.familyTasks.put(t);
    await toggleFamilyTask(F, t);
    // true — «задача общая»: снять, даже если у этого телефона уведомлений нет.
    expect(cancelReminder).toHaveBeenCalledWith('a', true);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('снятая отметка возвращает напоминание', async () => {
    const t = task('a', { completedAt: '2026-09-24T10:00:00.000Z', completedBy: 'me' });
    await db.familyTasks.put(t);
    await toggleFamilyTask(F, t);
    expect(scheduleReminder).toHaveBeenCalledWith({
      id: 'a',
      title: 'Задача a',
      dueDate: '2099-01-10',
      dueTime: null,
      remindBefore: 1440,
    });
  });

  it('удаление снимает его на сервере', async () => {
    await db.familyTasks.put(task('a'));
    await deleteFamilyTask(F, 'a');
    expect(cancelReminder).toHaveBeenCalledWith('a', true);
  });

  it('снятый срок снимает его на сервере, даже без своей подписки', async () => {
    // «Убрать» в карточке. Форма заодно гасит и «за сколько», но репозиторий
    // на это не полагается: у задачи без срока напоминания нет. Иначе снятый
    // срок ушёл бы в постановку, а та без своей подписки молча выходит.
    await db.familyTasks.put(task('a'));
    await updateFamilyTask(F, 'a', { dueDate: null, dueTime: null });
    expect(cancelReminder).toHaveBeenCalledWith('a', true);
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('правка цвета, приоритета или исполнителя напоминание не трогает', async () => {
    await db.familyTasks.put(task('a'));
    await updateFamilyTask(F, 'a', { color: '#10b981', priority: 3, assigneeId: 'p1', notes: 'хлеб' });
    expect(scheduleReminder).not.toHaveBeenCalled();
    expect(cancelReminder).not.toHaveBeenCalled();
  });

  it('новый срок переставляет его', async () => {
    await db.familyTasks.put(task('a'));
    await updateFamilyTask(F, 'a', { dueDate: '2099-01-12' });
    expect(scheduleReminder).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', dueDate: '2099-01-12' }));
  });
});

describe('перенос семейной задачи', () => {
  async function seed() {
    await db.familyTasks.bulkPut([
      task('a', { sortOrder: 3000 }),
      task('b', { sortOrder: 2000 }),
      task('c', { sortOrder: 1000 }),
    ]);
  }
  const order = async () =>
    (await db.familyTasks.toArray()).sort((x, y) => y.sortOrder - x.sortOrder).map((x) => x.id);

  it('пишет только сдвинутые задачи и прежними значениями', async () => {
    await seed();
    await reorderFamilyTasks(F, ['b', 'a', 'c']); // соседи поменялись местами
    expect(await order()).toEqual(['b', 'a', 'c']);
    expect(vi.mocked(sendItem).mock.calls.map((c) => c[2]).sort()).toEqual(['a', 'b']);
    expect((await db.familyTasks.get('b'))!.sortOrder).toBe(3000);
  });

  it('тот же порядок — ни одной отправки участникам', async () => {
    await seed();
    await reorderFamilyTasks(F, ['a', 'b', 'c']);
    expect(sendItem).not.toHaveBeenCalled();
    expect(scheduleReminder).not.toHaveBeenCalled();
  });

  it('пару с одинаковым значением можно поменять местами', async () => {
    // Такую пару оставляют встречные переносы двух участников.
    await db.familyTasks.bulkPut([
      task('a', { sortOrder: 3000 }),
      task('b', { sortOrder: 3000 }),
      task('c', { sortOrder: 1000 }),
    ]);
    await reorderFamilyTasks(F, ['b', 'a', 'c']);
    expect(await order()).toEqual(['b', 'a', 'c']);
  });
});
