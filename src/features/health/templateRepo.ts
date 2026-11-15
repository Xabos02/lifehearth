import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { alive, create, remove, update } from '../../db/repo';
import type { WorkoutTemplate } from '../../db/types';

export type TemplateDraft = Omit<WorkoutTemplate, keyof import('../../db/types').BaseEntity>;

export async function addTemplate(draft: TemplateDraft): Promise<WorkoutTemplate> {
  // Незаданные время и памятка в запись не идут вовсе — даже ключом.
  const { totalMinutes, note, ...rest } = draft;
  return create(db.workoutTemplates, { ...rest, ...(totalMinutes ? { totalMinutes } : {}), ...(note ? { note } : {}) });
}

/** Правка шаблона. Снятое время и стёртая памятка приходят как `undefined` —
 *  Dexie по нему удаляет поле из записи, а не хранит пустое. */
export async function updateTemplate(id: string, changes: Partial<TemplateDraft>): Promise<void> {
  await update(db.workoutTemplates, id, changes);
}

export async function removeTemplate(id: string): Promise<void> {
  await remove(db.workoutTemplates, id);
}

/** Живые шаблоны по алфавиту — один порядок в списке и в чипах карточки дня. */
export function useTemplates(): WorkoutTemplate[] {
  const rows = useLiveQuery(() => db.workoutTemplates.toArray(), []) ?? [];
  return alive(rows).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
