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

/** Живые шаблоны по алфавиту — один порядок в списке и в чипах карточки дня.
 *  `undefined` — база ещё не ответила: «Шаблонов пока нет» на первом кадре
 *  мелькало у того, у кого они есть. Запись без названия или видов (битая
 *  строка синка) пропускается: сортировка по ней роняла бы всю вкладку. */
export function useTemplates(): WorkoutTemplate[] | undefined {
  const rows = useLiveQuery(() => db.workoutTemplates.toArray(), []);
  return rows && alive(rows)
    .filter((tpl) => typeof tpl.name === 'string' && Array.isArray(tpl.items))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
