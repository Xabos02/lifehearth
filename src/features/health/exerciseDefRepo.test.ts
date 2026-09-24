import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from '../../db/db';
import { addExerciseDef } from './exerciseDefRepo';

beforeEach(async () => {
  await db.exerciseDefs.clear();
});

it('то же название второй раз — то же упражнение, а не второй чип с другим цветом', async () => {
  const first = await addExerciseDef('Йога');
  const again = await addExerciseDef('йога');
  expect(again.id).toBe(first.id);
  expect(again.color).toBe(first.color);
  expect(await db.exerciseDefs.count()).toBe(1);
});

it('двойное нажатие «Добавить» — одно упражнение, а не два', async () => {
  // Два вызова одновременно: без общей транзакции оба успевали проверить, что
  // «Йоги» нет, и заводили по строке.
  const [a, b] = await Promise.all([addExerciseDef('Йога'), addExerciseDef('Йога')]);
  expect(a.id).toBe(b.id);
  expect(await db.exerciseDefs.count()).toBe(1);
});
