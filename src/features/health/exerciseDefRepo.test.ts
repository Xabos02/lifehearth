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
