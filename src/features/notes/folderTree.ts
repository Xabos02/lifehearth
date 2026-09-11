// Дерево папок заметок: чистые обходы поверх плоского списка с parentId.
// Ничего не знает про Dexie и React — только структуры.

import type { Note, NoteFolder } from '../../db/types';

const rootOf = (f: NoteFolder): string | null => f.parentId ?? null;

/** Дети каждого уровня, отсортированные как в списке (по sortOrder).
 *  Ключ '' — корень: у Map с null-ключом типизация хуже, чем польза. */
export function childrenByParent(folders: NoteFolder[]): Map<string, NoteFolder[]> {
  const by = new Map<string, NoteFolder[]>();
  for (const f of folders) {
    const key = rootOf(f) ?? '';
    const list = by.get(key);
    if (list) list.push(f);
    else by.set(key, [f]);
  }
  for (const list of by.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
  return by;
}

/** Папка и все её потомки. Нужна счётчику заметок и переносу: «в себя или
 *  своего потомка» — единственный запрещённый ход. */
export function withDescendants(folders: NoteFolder[], rootId: string): Set<string> {
  const by = childrenByParent(folders);
  const out = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    for (const child of by.get(queue.pop()!) ?? []) {
      // Защита от цикла в битых данных: посещённое не обходим второй раз,
      // иначе экран заметок повис бы навсегда из-за одной кривой записи.
      if (!out.has(child.id)) {
        out.add(child.id);
        queue.push(child.id);
      }
    }
  }
  return out;
}

/** Сколько заметок в папке ВМЕСТЕ с вложенными — как считает Apple Notes:
 *  цифра у папки отвечает «сколько я найду внутри», а не «сколько лежит на
 *  этом уровне». */
export function countNotesDeep(notes: Note[], folders: NoteFolder[], folderId: string): number {
  const ids = withDescendants(folders, folderId);
  return notes.reduce((acc, n) => acc + (n.folderId && ids.has(n.folderId) ? 1 : 0), 0);
}

/** Дерево одним списком с глубиной — для экранов, где иерархию показывают
 *  отступом («Куда перенести?»). Обход в глубину, внутри уровня — sortOrder. */
export function flattenTree(folders: NoteFolder[]): Array<{ folder: NoteFolder; depth: number }> {
  const by = childrenByParent(folders);
  const out: Array<{ folder: NoteFolder; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parentKey: string, depth: number) => {
    for (const f of by.get(parentKey) ?? []) {
      if (seen.has(f.id)) continue; // цикл в битых данных — не зависаем
      seen.add(f.id);
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk('', 0);
  // Осиротевшие ветки (родитель удалён на другом устройстве, синк ещё не
  // довёз каскад) показываем в корне: спрятать папку — значит «потерять»
  // её заметки для человека.
  for (const f of folders) {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      out.push({ folder: f, depth: 0 });
      walk(f.id, 1);
    }
  }
  return out;
}

/** Куда можно перенести папку: всё дерево без неё самой и её потомков.
 *  Перенос в себя зациклил бы дерево, перенос в потомка — оторвал бы ветку
 *  от корня; оба хода просто не показываются как цели. */
export function folderMoveTargets(
  folders: NoteFolder[],
  folderId: string,
): Array<{ folder: NoteFolder; depth: number }> {
  const banned = withDescendants(folders, folderId);
  return flattenTree(folders).filter(({ folder }) => !banned.has(folder.id));
}

/** Переставить папку внутри её уровня: fromId встаёт на место toIndex среди
 *  соседей (индекс — как в списке ДО перестановки, как у линии вставки при
 *  переносе). Возвращает только те пары id → sortOrder, которые изменились,
 *  по схеме (i + 1) * 1000 — так же, как у проектов в «Задачах».
 *
 *  Почему не «поменять два числа местами»: у всех существующих папок
 *  sortOrder = момент создания в миллисекундах, соседние значения отличаются
 *  на единицы, и вставить между ними нечего. Пересчёт всего уровня даёт
 *  честные промежутки для следующих перестановок. */
export function reorderWithin(
  siblings: Array<Pick<NoteFolder, 'id' | 'sortOrder'>>,
  fromId: string,
  toIndex: number,
): Array<{ id: string; sortOrder: number }> {
  const ids = [...siblings].sort((a, b) => a.sortOrder - b.sortOrder).map((f) => f.id);
  const from = ids.indexOf(fromId);
  if (from === -1) return [];
  const next = ids.filter((id) => id !== fromId);
  const clamped = Math.max(0, Math.min(toIndex, ids.length));
  const insertAt = clamped > from ? clamped - 1 : clamped;
  next.splice(insertAt, 0, fromId);
  if (!next.some((id, i) => ids[i] !== id)) return [];
  const byId = new Map(siblings.map((f) => [f.id, f.sortOrder]));
  const out: Array<{ id: string; sortOrder: number }> = [];
  next.forEach((id, i) => {
    const order = (i + 1) * 1000;
    if (byId.get(id) !== order) out.push({ id, sortOrder: order });
  });
  return out;
}
