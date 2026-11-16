import type { Priority } from '../db/types';

type Ordered = { priority: Priority; sortOrder: number };

/** Сколько важных стоит во главе списка подряд. */
const headOf = (list: ReadonlyArray<Ordered>): number => {
  const k = list.findIndex((t) => t.priority !== 3);
  return k === -1 ? list.length : k;
};

/**
 * Порядок новой обычной задачи — первой среди обычных, сразу под важными,
 * что стоят во главе списка (владелец, 16.11.2026: «важные над новыми»).
 * Важных во главе нет — на самый верх (top).
 *
 * list — активные задачи того же списка в порядке экрана; dir — куда растёт
 * порядок вниз по экрану: 1 у «Задач», -1 у семейных (их список по убыванию).
 * Важная, утащенная человеком вниз, во «главу» не входит — новая встаёт под
 * теми, что наверху.
 *
 * null — зазор между последней важной и первой обычной кончился (каждая
 * новая делит его пополам, а точность double конечна): список надо
 * перенумеровать — renumberUnderHigh.
 */
export function orderUnderHigh(list: ReadonlyArray<Ordered>, top: number, dir: 1 | -1 = 1): number | null {
  const k = headOf(list);
  if (k === 0) return top;
  const last = list[k - 1].sortOrder;
  if (k === list.length) return last + dir * 1000;
  const first = list[k].sortOrder;
  const order = first - dir * Math.min(1000, Math.abs(first - last) / 2);
  return order === first || order === last ? null : order;
}

/** Зазор под важными кончился: порядок списка раздаётся заново шагом 1000,
 *  с местом для новой сразу под главой. Возвращает её порядок и записи для
 *  тех, чей порядок поменялся. */
export function renumberUnderHigh<T extends Ordered & { id: string }>(
  list: ReadonlyArray<T>,
  dir: 1 | -1 = 1,
): { order: number; writes: { id: string; sortOrder: number }[] } {
  const k = headOf(list);
  const n = list.length + 1;
  const slot = (i: number) => (dir === 1 ? (i + 1) * 1000 : (n - i) * 1000);
  const writes: { id: string; sortOrder: number }[] = [];
  list.forEach((t, i) => {
    const sortOrder = slot(i < k ? i : i + 1);
    if (sortOrder !== t.sortOrder) writes.push({ id: t.id, sortOrder });
  });
  return { order: slot(k), writes };
}
