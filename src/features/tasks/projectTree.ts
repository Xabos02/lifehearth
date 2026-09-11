import type { Project } from '../../db/types';
import { MAX_DEPTH } from './dragTuning';

// Дерево проектов: те же правила, что у папок заметок (notes/folderTree.ts),
// но со своим пределом глубины. Всё поверх плоского списка с parentId, без
// Dexie и React — чтобы проверяться тестами, не поднимая браузер.
//
// Появилось 11.09.2026, когда владелец попросил прикреплять проект вместе с
// его подпроектами к другому проекту. До того глубина была жёстко два уровня
// и держалась на трёх разрозненных запретах: в форме, в переносе и в самой
// разметке. Теперь правило одно и здесь.

type Node = Pick<Project, 'id' | 'parentId'>;

function byId(projects: Node[]): Map<string, Node> {
  return new Map(projects.map((p) => [p.id, p]));
}

/** Глубина проекта: 1 — верхний уровень, 2 — подпроект, 3 — под-подпроект.
 *  Битую ссылку на несуществующего родителя считаем корнем — так же, как
 *  рендер, который показывает такой проект наверху. */
export function depthOf(projects: Node[], id: string): number {
  const map = byId(projects);
  let depth = 1;
  let cur = map.get(id);
  const seen = new Set<string>();
  while (cur?.parentId && map.has(cur.parentId) && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth += 1;
    cur = map.get(cur.parentId);
  }
  return depth;
}

/** Все потомки проекта — дети, внуки и дальше. Без самого проекта. */
export function descendantsOf(projects: Node[], rootId: string): Set<string> {
  const kids = new Map<string, string[]>();
  for (const p of projects) {
    if (!p.parentId) continue;
    const arr = kids.get(p.parentId);
    if (arr) arr.push(p.id);
    else kids.set(p.parentId, [p.id]);
  }
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const k of kids.get(id) ?? []) {
      if (out.has(k)) continue;
      out.add(k);
      stack.push(k);
    }
  }
  return out;
}

/** Высота поддерева: 1 — подпроектов нет, 2 — есть дети, 3 — есть внуки. */
export function heightOf(projects: Node[], rootId: string): number {
  const kids = new Map<string, string[]>();
  for (const p of projects) {
    if (!p.parentId) continue;
    const arr = kids.get(p.parentId);
    if (arr) arr.push(p.id);
    else kids.set(p.parentId, [p.id]);
  }
  const walk = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    let best = 0;
    for (const k of kids.get(id) ?? []) best = Math.max(best, walk(k, seen));
    return best + 1;
  };
  return walk(rootId, new Set());
}

/** Почему проект нельзя вложить в цель. null — можно. */
export type NestRefusal = 'self' | 'cycle' | 'depth';

/** Можно ли сделать проект moving подпроектом проекта target.
 *
 *  Три отказа, и каждый со своей причиной для человека:
 *  - self  — в самого себя;
 *  - cycle — в собственного потомка: дерево замкнулось бы в кольцо, и оба
 *            проекта вместе с задачами пропали бы с экрана;
 *  - depth — глубина цели плюс высота переносимого поддерева выходят за
 *            MAX_DEPTH: глубже телефон не вмещает. */
export function nestRefusal(projects: Node[], movingId: string, targetId: string): NestRefusal | null {
  if (movingId === targetId) return 'self';
  if (descendantsOf(projects, movingId).has(targetId)) return 'cycle';
  if (depthOf(projects, targetId) + heightOf(projects, movingId) > MAX_DEPTH) return 'depth';
  return null;
}

/** Кандидаты в родители для формы проекта — только те, куда вложить можно. */
export function parentCandidates<P extends Node>(projects: P[], movingId: string | null): P[] {
  return projects.filter((p) => {
    if (!movingId) return depthOf(projects, p.id) < MAX_DEPTH; // новый проект — высота 1
    return nestRefusal(projects, movingId, p.id) === null;
  });
}
