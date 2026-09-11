import { describe, expect, it } from 'vitest';
import type { Note, NoteFolder } from '../../db/types';
import {
  childrenByParent,
  countNotesDeep,
  flattenTree,
  folderMoveTargets,
  withDescendants,
  reorderWithin,
} from './folderTree';

const F = (id: string, parentId: string | null, sortOrder = 0): NoteFolder => ({
  id,
  name: id,
  emoji: '📁',
  color: '#000',
  sortOrder,
  parentId,
  createdAt: '',
  updatedAt: '',
  deletedAt: null,
});

const N = (id: string, folderId: string | null): Note => ({
  id,
  title: id,
  content: '',
  tags: [],
  pinned: false,
  folderId,
  createdAt: '',
  updatedAt: '',
  deletedAt: null,
});

// Работа › Проекты › RTE; Дом — отдельно в корне.
const TREE = [F('work', null, 1), F('home', null, 2), F('proj', 'work'), F('rte', 'proj')];

describe('дерево папок', () => {
  it('дети раскладываются по уровням и сортируются', () => {
    const by = childrenByParent(TREE);
    expect(by.get('')!.map((f) => f.id)).toEqual(['work', 'home']);
    expect(by.get('work')!.map((f) => f.id)).toEqual(['proj']);
    expect(by.get('rte')).toBeUndefined();
  });

  it('потомки собираются на всю глубину', () => {
    expect([...withDescendants(TREE, 'work')].sort()).toEqual(['proj', 'rte', 'work']);
    expect([...withDescendants(TREE, 'home')]).toEqual(['home']);
  });

  it('счётчик считает заметки вместе с вложенными папками', () => {
    const notes = [N('a', 'work'), N('b', 'rte'), N('c', 'home'), N('d', null)];
    expect(countNotesDeep(notes, TREE, 'work')).toBe(2); // своя + в глубине
    expect(countNotesDeep(notes, TREE, 'proj')).toBe(1);
    expect(countNotesDeep(notes, TREE, 'home')).toBe(1);
  });

  it('flatten даёт порядок обхода в глубину с глубиной уровня', () => {
    expect(flattenTree(TREE).map((x) => `${x.folder.id}:${x.depth}`)).toEqual([
      'work:0',
      'proj:1',
      'rte:2',
      'home:0',
    ]);
  });

  it('осиротевшая ветка не исчезает — поднимается в корень', () => {
    // Родитель 'lost' не существует (удалён на другом устройстве).
    const rows = [F('a', null), F('orphan', 'lost'), F('child', 'orphan')];
    const flat = flattenTree(rows).map((x) => `${x.folder.id}:${x.depth}`);
    expect(flat).toEqual(['a:0', 'orphan:0', 'child:1']);
  });

  it('цикл в битых данных не подвешивает обход', () => {
    const rows = [F('x', 'y'), F('y', 'x')];
    expect(flattenTree(rows)).toHaveLength(2);
    expect(withDescendants(rows, 'x').size).toBe(2);
  });

  it('цели переноса папки — без неё самой и её потомков', () => {
    // 'work' нельзя ни в себя, ни в 'proj'/'rte' (свои потомки) — только 'home'.
    expect(folderMoveTargets(TREE, 'work').map((x) => x.folder.id)).toEqual(['home']);
    // Листовой 'rte' можно куда угодно, кроме себя; порядок — как в дереве.
    expect(folderMoveTargets(TREE, 'rte').map((x) => x.folder.id)).toEqual([
      'work',
      'proj',
      'home',
    ]);
  });
});


// Папки, созданные подряд: sortOrder = момент создания, разница в миллисекунды.
const sib = [
  { id: 'a', sortOrder: 1757500000001 },
  { id: 'b', sortOrder: 1757500000002 },
  { id: 'c', sortOrder: 1757500000003 },
];
const order = (list: typeof sib, changes: Array<{ id: string; sortOrder: number }>) =>
  list
    .map((f) => ({ ...f, sortOrder: changes.find((c) => c.id === f.id)?.sortOrder ?? f.sortOrder }))
    .sort((x, y) => x.sortOrder - y.sortOrder)
    .map((f) => f.id);

describe('перестановка папок внутри уровня', () => {
  it('в начало', () => {
    expect(order(sib, reorderWithin(sib, 'c', 0))).toEqual(['c', 'a', 'b']);
  });
  it('в конец', () => {
    expect(order(sib, reorderWithin(sib, 'a', 3))).toEqual(['b', 'c', 'a']);
  });
  it('между двумя значениями, отличающимися на миллисекунды', () => {
    expect(order(sib, reorderWithin(sib, 'c', 1))).toEqual(['a', 'c', 'b']);
  });
  it('на то же место — ничего не пишем', () => {
    expect(reorderWithin(sib, 'b', 1)).toEqual([]);
    expect(reorderWithin(sib, 'b', 2)).toEqual([]); // линия сразу под собой
  });
  it('чужой id — ничего', () => {
    expect(reorderWithin(sib, 'zzz', 0)).toEqual([]);
  });
  it('пересчитывает весь уровень ровными шагами', () => {
    const ch = reorderWithin(sib, 'c', 0);
    expect(ch.map((x) => x.sortOrder)).toEqual([1000, 2000, 3000]);
  });
  it('индекс за пределами списка прижимается к концу', () => {
    expect(order(sib, reorderWithin(sib, 'a', 99))).toEqual(['b', 'c', 'a']);
  });
});
