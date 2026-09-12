import { db } from '../../db/db';
import { create, remove, update } from '../../db/repo';
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

/** Импорт разобранных строк — одной транзакцией, все с пометкой source=import. */
export async function importParsed(rows: ParsedWorkout[]): Promise<number> {
  for (const r of rows) {
    await create(db.workouts, {
      date: r.date,
      type: r.type,
      minutes: r.minutes,
      distanceKm: r.distanceKm,
      effort: null,
      note: r.note,
      source: 'import',
    });
  }
  return rows.length;
}
