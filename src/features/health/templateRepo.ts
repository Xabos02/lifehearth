import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { alive, create, remove, update, updateMany } from '../../db/repo';
import type { WorkoutTemplate } from '../../db/types';
import { newSortOrder } from '../tasks/taskActions';
import { reorderWithin } from '../notes/folderTree';

export type TemplateDraft = Omit<WorkoutTemplate, keyof import('../../db/types').BaseEntity>;

export async function addTemplate(draft: TemplateDraft): Promise<WorkoutTemplate> {
  // Незаданные время и памятка в запись не идут вовсе — даже ключом.
  // Новый шаблон — первым, как новые проекты и задачи (PROTOCOL §6.3): список
  // после «Сохранить» открывается сверху, и новое сразу на виду.
  const { totalMinutes, note, ...rest } = draft;
  return create(db.workoutTemplates, {
    ...rest,
    sortOrder: newSortOrder(),
    ...(totalMinutes ? { totalMinutes } : {}),
    ...(note ? { note } : {}),
  });
}

/** Правка шаблона. Снятое время и стёртая памятка приходят как `undefined` —
 *  Dexie по нему удаляет поле из записи, а не хранит пустое. */
export async function updateTemplate(id: string, changes: Partial<TemplateDraft>): Promise<void> {
  await update(db.workoutTemplates, id, changes);
}

export async function removeTemplate(id: string): Promise<void> {
  await remove(db.workoutTemplates, id);
}

/** Порядок шаблонов: свой (sortOrder), без него — после пронумерованных и по
 *  алфавиту. Старые шаблоны поля не имеют, и после обновления не прыгают:
 *  стоят, как стояли, пока их не переставят. Не число (битая строка синка) —
 *  как без поля. */
export function byTemplateOrder(a: WorkoutTemplate, b: WorkoutTemplate): number {
  const oa = typeof a.sortOrder === 'number' ? a.sortOrder : Infinity;
  const ob = typeof b.sortOrder === 'number' ? b.sortOrder : Infinity;
  if (oa !== ob) return oa < ob ? -1 : 1;
  return a.name.localeCompare(b.name, 'ru');
}

/** Что записать, чтобы шаблон `id` встал перед строкой `toIndex` списка `list`
 *  (порядок экрана; `list.length` — в конец). Счёт места — общий с папками
 *  «Заметок» (`reorderWithin`); ему отдаём место на экране, а не sortOrder:
 *  у старых шаблонов поля нет. Первый перенос нумерует весь список шагом
 *  1000; в ответе — только записи, у которых число и правда меняется. */
export function templateOrderChanges(list: WorkoutTemplate[], id: string, toIndex: number): Array<{ id: string; sortOrder: number }> {
  const next = reorderWithin(list.map((tpl, i) => ({ id: tpl.id, sortOrder: i })), id, toIndex);
  const was = new Map(list.map((tpl) => [tpl.id, tpl.sortOrder]));
  return next.filter((c) => was.get(c.id) !== c.sortOrder);
}

/** Список после переноса — показать новый порядок в том же кадре, что
 *  снимает линию, до ответа базы (PROTOCOL §6.3, накладка как `pendingOrder`). */
export function withTemplateOrder(list: WorkoutTemplate[], changes: Array<{ id: string; sortOrder: number }>): WorkoutTemplate[] {
  const to = new Map(changes.map((c) => [c.id, c.sortOrder]));
  return list.map((tpl) => (to.has(tpl.id) ? { ...tpl, sortOrder: to.get(tpl.id) } : tpl)).sort(byTemplateOrder);
}

/** Порядок после переноса — одной пачкой (PROTOCOL §6.3): один updatedAt,
 *  одна отправка в синк. */
export async function saveTemplateOrder(changes: Array<{ id: string; sortOrder: number }>): Promise<void> {
  await updateMany(db.workoutTemplates, changes.map((c) => ({ id: c.id, changes: { sortOrder: c.sortOrder } })));
}

/** Живые шаблоны в их порядке (byTemplateOrder) — один порядок в списке и в
 *  чипах карточки дня. `undefined` — база ещё не ответила: «Шаблонов пока
 *  нет» на первом кадре мелькало у того, у кого они есть. Запись без названия
 *  или видов (битая строка синка) пропускается: сортировка по ней роняла бы
 *  всю вкладку. */
export function useTemplates(): WorkoutTemplate[] | undefined {
  const rows = useLiveQuery(() => db.workoutTemplates.toArray(), []);
  // Тот же массив, пока база не ответила новым: шторка по смене списка снимает
  // накладку переноса — новый на каждом рендере снимал бы её в следующем кадре.
  return useMemo(
    () => rows && alive(rows)
      .filter((tpl) => typeof tpl.name === 'string' && Array.isArray(tpl.items))
      .sort(byTemplateOrder),
    [rows],
  );
}
