import { db } from '../../db/db';
import { create, now, remove, uid, update } from '../../db/repo';
import { scheduleSyncSoon } from '../../lib/sync';
import type { Workout } from '../../db/types';
import type { ParsedWorkout } from './importWorkouts';

export type WorkoutDraft = Omit<Workout, keyof import('../../db/types').BaseEntity>;

export async function addWorkout(draft: WorkoutDraft): Promise<Workout> {
  return create(db.workouts, draft);
}

export async function updateWorkout(id: string, changes: Partial<WorkoutDraft>): Promise<void> {
  await update(db.workouts, id, changes);
}

export async function removeWorkout(id: string): Promise<void> {
  await remove(db.workouts, id);
}

/** Несколько видов «в одно целое» — одна транзакция, один groupId на всех,
 *  если видов больше одного (один вид — как раньше, groupId=null: старые
 *  записи и импорт от него не отличить). */
export async function addWorkoutSession(items: WorkoutDraft[]): Promise<Workout[]> {
  const groupId = items.length > 1 ? uid() : null;
  const ts = now();
  const rows: Workout[] = items.map((draft) => ({
    ...draft,
    groupId,
    id: uid(),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
  }));
  await db.transaction('rw', db.workouts, async () => {
    await db.workouts.bulkAdd(rows);
  });
  scheduleSyncSoon();
  return rows;
}

/** Импорт разобранных строк — одной транзакцией: выгрузка за год это сотни
 *  строк, и по одной они бы дёргали liveQuery экрана на каждую, а обрыв на
 *  середине оставлял бы половину. Все с пометкой source=import. */
export async function importParsed(rows: ParsedWorkout[]): Promise<number> {
  await db.transaction('rw', db.workouts, async () => {
    for (const r of rows) {
      await create(db.workouts, {
        date: r.date,
        type: r.type,
        minutes: r.minutes,
        distanceKm: r.distanceKm,
        effort: null,
        note: r.note,
        source: 'import',
        groupId: null,
        customLabel: null,
        customColor: null,
      });
    }
  });
  return rows.length;
}
