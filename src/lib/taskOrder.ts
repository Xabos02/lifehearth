import type { Priority } from '../db/types';

/**
 * Порядок новой обычной задачи — первой среди обычных, сразу под важными,
 * что стоят во главе списка (владелец, 16.11.2026: «важные над новыми»).
 * Важных во главе нет — на самый верх (top).
 *
 * list — активные задачи того же списка в порядке экрана; dir — куда растёт
 * порядок вниз по экрану: 1 у «Задач», -1 у семейных (их список по убыванию).
 * Важная, утащенная человеком вниз, во «главу» не входит — новая встаёт под
 * теми, что наверху.
 */
export function orderUnderHigh(
  list: ReadonlyArray<{ priority: Priority; sortOrder: number }>,
  top: number,
  dir: 1 | -1 = 1,
): number {
  const k = list.findIndex((t) => t.priority !== 3);
  if (k === 0 || list.length === 0) return top;
  const last = list[(k === -1 ? list.length : k) - 1].sortOrder;
  if (k === -1) return last + dir * 1000;
  const first = list[k].sortOrder;
  // ponytail: после переноса зазор между важной и обычной — 1000, и каждая
  // новая делит его пополам: ~50 новых подряд без единого переноса — и
  // порядки сольются. Перенос раздаёт порядок заново ((i+1)*1000).
  return first - dir * Math.min(1000, Math.abs(first - last) / 2);
}
