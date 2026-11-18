import { db } from '../../db/db';
import { alive, create, uid, updateMany } from '../../db/repo';
import { scheduleSyncSoon } from '../../lib/sync';
import { isDateKey } from '../../lib/dates';
import type { Workout } from '../../db/types';
import { dupKey, UNDONE, type ParsedWorkout } from './importWorkouts';

export type WorkoutDraft = Omit<Workout, keyof import('../../db/types').BaseEntity>;

/** Живые тренировки для экранов — без записей с днём, которого нет в
 *  календаре ('2026-02-31', '2026-25-09'). Такие записывал импорт CSV до
 *  15.11.2026, синк привозит их и с других устройств, а format на такой дате
 *  бросает RangeError: вместо «Спорта» и «Сегодня» было «Что-то пошло не так»,
 *  и после перезагрузки тоже. */
export function shownWorkouts(rows: Workout[]): Workout[] {
  return alive(rows).filter((w) => isDateKey(w.date));
}

export async function addWorkout(draft: WorkoutDraft): Promise<Workout> {
  return create(db.workouts, draft);
}

/** Мягкое удаление вида или всего занятия — одной записью: убитая на
 *  середине вкладка не оставит полузанятие. */
export async function removeWorkouts(ids: string[]): Promise<void> {
  const ts = new Date().toISOString();
  await updateMany(db.workouts, ids.map((id) => ({ id, changes: { deletedAt: ts } })));
}

/** Правка вида и перенос остальных видов его занятия на тот же день — одной
 *  записью (аудит 1.64.0, H2): по одной убитая между правками вкладка
 *  оставила бы занятие на двух днях. */
export async function updateWithMates(id: string, changes: Partial<WorkoutDraft>, mates: Workout[]): Promise<void> {
  await updateMany(db.workouts, [{ id, changes }, ...mates.map((m) => ({ id: m.id, changes: { date: changes.date } }))]);
}

/** Другие живые виды того же занятия (общий groupId). */
export async function sessionMates(w: Workout): Promise<Workout[]> {
  if (!w.groupId) return [];
  return alive(await db.workouts.where('groupId').equals(w.groupId).toArray()).filter((x) => x.id !== w.id);
}

/** Несколько видов «в одно целое» — одна транзакция, один groupId на всех,
 *  если видов больше одного (один вид — как раньше, groupId=null: старые
 *  записи и импорт от него не отличить). */
export async function addWorkoutSession(items: WorkoutDraft[]): Promise<Workout[]> {
  const groupId = items.length > 1 ? uid() : null;
  // Порядок ввода — в createdAt, по миллисекунде на вид: с одной меткой на
  // всех список дня ставил виды занятия по случайному id.
  const t0 = Date.now();
  const rows: Workout[] = items.map((draft, i) => {
    const ts = new Date(t0 + i).toISOString();
    return { ...draft, groupId, id: uid(), createdAt: ts, updatedAt: ts, deletedAt: null };
  });
  await db.transaction('rw', db.workouts, async () => {
    await db.workouts.bulkAdd(rows);
  });
  scheduleSyncSoon();
  return rows;
}

/** Импорт разобранных строк — одной транзакцией: выгрузка за год это сотни
 *  строк, и по одной они бы дёргали liveQuery экрана на каждую, а обрыв на
 *  середине оставлял бы половину. Все с пометкой source=import. */
export async function importParsed(rows: ParsedWorkout[]): Promise<string[]> {
  const ids: string[] = [];
  await db.transaction('rw', db.workouts, async () => {
    for (const r of rows) {
      const w = await create(db.workouts, {
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
        importKey: dupKey(r),
      });
      ids.push(w.id);
    }
  });
  return ids;
}

/** «Вернуть» после импорта: пачка мягко удаляется одной записью (могла уже
 *  уйти в синк — жёсткое удаление вернулось бы с сервера), а её ключи
 *  помечаются отменёнными: тот же файл потом импортируется снова. */
export async function undoImport(ids: string[]): Promise<void> {
  const rows = await db.workouts.bulkGet(ids);
  const ts = new Date().toISOString();
  await updateMany(
    db.workouts,
    rows.flatMap((w) => (w ? [{ id: w.id, changes: { deletedAt: ts, importKey: UNDONE + (w.importKey ?? dupKey(w)) } }] : [])),
  );
}
