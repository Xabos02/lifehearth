import { db } from '../../db/db';
import { create, remove } from '../../db/repo';
import type { ExerciseDef } from '../../db/types';
import { nextCustomColor } from './workouts';

export type ExerciseDefDraft = Omit<ExerciseDef, keyof import('../../db/types').BaseEntity>;

/** Завести своё упражнение — цвет берётся по кругу от числа уже заведённых,
 *  чтобы у каждого нового имени была своя точка в календаре и списках. */
export async function addExerciseDef(label: string, hasDistance = false, defaultMinutes = 30): Promise<ExerciseDef> {
  const existing = (await db.exerciseDefs.toArray()).filter((d) => !d.deletedAt);
  // То же название второй раз — то же упражнение: иначе рядом вставал второй
  // чип «Йога» со своим цветом, и одно упражнение в календаре метилось
  // точками двух цветов.
  const same = existing.find((d) => d.label.toLowerCase() === label.toLowerCase());
  if (same) return same;
  return create(db.exerciseDefs, {
    label,
    color: nextCustomColor(existing.length),
    hasDistance,
    defaultMinutes,
  });
}

export async function removeExerciseDef(id: string): Promise<void> {
  await remove(db.exerciseDefs, id);
}
