import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../../db/db';
import type { WorkoutTemplate } from '../../db/types';
import { addTemplate, byTemplateOrder, saveTemplateOrder, templateOrderChanges, withTemplateOrder } from './templateRepo';

// Порядок шаблонов (канва design/template-order, А, 17.11.2026): у старых
// шаблонов поля нет — они не должны прыгать после обновления, а первый же
// перенос нумерует весь список.

const tpl = (id: string, name: string, sortOrder?: number): WorkoutTemplate => ({
  id,
  name,
  items: [],
  createdAt: '',
  updatedAt: '',
  deletedAt: null,
  ...(sortOrder === undefined ? {} : { sortOrder }),
});
const names = (list: WorkoutTemplate[]) => list.map((t) => t.name);

beforeEach(async () => {
  await db.workoutTemplates.clear();
});

it('без порядка — по алфавиту и после пронумерованных; не число — как без поля', () => {
  const list = [
    tpl('b', 'Тренировка Б'),
    tpl('k', 'Контрольный день'),
    tpl('x', 'Битая', 'abc' as unknown as number),
    tpl('a', 'Тренировка А', 2000),
    tpl('v', 'Тренировка В', -5),
  ].sort(byTemplateOrder);
  expect(names(list)).toEqual(['Тренировка В', 'Тренировка А', 'Битая', 'Контрольный день', 'Тренировка Б']);
});

it('первый перенос нумерует весь список; отпустил там же — ничего', () => {
  const list = [tpl('k', 'Контрольный день'), tpl('a', 'Тренировка А'), tpl('b', 'Тренировка Б')];
  // Над своей строкой и под ней — то же место.
  expect(templateOrderChanges(list, 'k', 0)).toEqual([]);
  expect(templateOrderChanges(list, 'k', 1)).toEqual([]);
  const changes = templateOrderChanges(list, 'k', 3);
  expect(changes).toEqual([
    { id: 'a', sortOrder: 1000 },
    { id: 'b', sortOrder: 2000 },
    { id: 'k', sortOrder: 3000 },
  ]);
  expect(names(withTemplateOrder(list, changes))).toEqual(['Тренировка А', 'Тренировка Б', 'Контрольный день']);
});

it('следующий перенос пишет только то, что сдвинулось', () => {
  const list = [tpl('a', 'Тренировка А', 1000), tpl('b', 'Тренировка Б', 2000), tpl('k', 'Контрольный день', 3000)];
  const changes = templateOrderChanges(list, 'b', 0);
  expect(changes).toEqual([
    { id: 'b', sortOrder: 1000 },
    { id: 'a', sortOrder: 2000 },
  ]);
  expect(names(withTemplateOrder(list, changes))).toEqual(['Тренировка Б', 'Тренировка А', 'Контрольный день']);
});

it('новый шаблон — первым, и над переставленными, и над старыми без порядка', async () => {
  await db.workoutTemplates.bulkPut([tpl('old', 'Авангард'), tpl('a', 'Тренировка А', 1000)]);
  await addTemplate({ name: 'Ярмарка', items: [] });
  const list = (await db.workoutTemplates.toArray()).sort(byTemplateOrder);
  expect(names(list)).toEqual(['Ярмарка', 'Тренировка А', 'Авангард']);
});

it('запись порядка — одной пачкой с одним updatedAt, остальные поля целы', async () => {
  await db.workoutTemplates.bulkPut([
    { ...tpl('a', 'Тренировка А'), totalMinutes: 70, note: 'Запас 1–2 повтора' },
    tpl('b', 'Тренировка Б'),
  ]);
  await saveTemplateOrder([
    { id: 'b', sortOrder: 1000 },
    { id: 'a', sortOrder: 2000 },
  ]);
  const [a, b] = await Promise.all([db.workoutTemplates.get('a'), db.workoutTemplates.get('b')]);
  expect([b?.sortOrder, a?.sortOrder]).toEqual([1000, 2000]);
  expect(a?.updatedAt).toBe(b?.updatedAt);
  expect(a?.updatedAt).not.toBe('');
  expect([a?.totalMinutes, a?.note]).toEqual([70, 'Запас 1–2 повтора']);
});
