import { describe, expect, it } from 'vitest';
import { orderUnderHigh, renumberUnderHigh } from './taskOrder';

const TOP = -1_800_000_000_000;
type T = { id: string; priority: 0 | 3; sortOrder: number };
let seq = 0;
const t = (priority: 0 | 3, sortOrder: number): T => ({ id: `t${seq++}`, priority, sortOrder });

/** Где встанет новая: индекс в списке после сортировки по направлению. */
function placed(list: T[], order: number | null, dir: 1 | -1 = 1): number {
  if (order === null) throw new Error('зазор кончился');
  return [...list.map((x) => x.sortOrder), order].sort((a, b) => dir * (a - b)).indexOf(order);
}

/** Добавить новую обычную так, как это делает приложение: место, а если
 *  зазор кончился — перенумеровать. Возвращает, понадобилась ли перенумерация. */
function add(list: T[], top: number, dir: 1 | -1): boolean {
  let order = orderUnderHigh(list, top, dir);
  const renumbered = order === null;
  if (order === null) {
    const fresh = renumberUnderHigh(list, dir);
    for (const w of fresh.writes) list.find((x) => x.id === w.id)!.sortOrder = w.sortOrder;
    order = fresh.order;
  }
  list.push(t(0, order));
  list.sort((a, b) => dir * (a.sortOrder - b.sortOrder));
  return renumbered;
}

describe('orderUnderHigh', () => {
  it('пустой список и список без важных во главе — на самый верх', () => {
    expect(orderUnderHigh([], TOP)).toBe(TOP);
    expect(orderUnderHigh([t(0, 1000), t(3, 2000)], TOP)).toBe(TOP);
  });

  it('встаёт сразу под важными во главе — и после переноса, и после подъёма', () => {
    const afterDrag = [t(3, 1000), t(3, 2000), t(0, 3000), t(0, 4000)];
    expect(placed(afterDrag, orderUnderHigh(afterDrag, TOP))).toBe(2);
    const afterRaise = [t(3, -1_790_000_000_000), t(0, 1_780_000_000_000)];
    expect(placed(afterRaise, orderUnderHigh(afterRaise, TOP))).toBe(1);
    expect(orderUnderHigh(afterRaise, TOP)).toBe(1_780_000_000_000 - 1000);
  });

  it('утащенная вниз важная в главу не входит', () => {
    const list = [t(3, 1000), t(0, 2000), t(3, 3000)];
    expect(placed(list, orderUnderHigh(list, TOP))).toBe(1);
  });

  it('одни важные — встаёт последней', () => {
    const list = [t(3, 1000), t(3, 2000)];
    expect(placed(list, orderUnderHigh(list, TOP))).toBe(2);
  });

  it('семейный список по убыванию — то же самое зеркально', () => {
    const now = 1_790_000_000_000;
    const list = [t(3, now - 10), t(0, now - 20_000)];
    expect(placed(list, orderUnderHigh(list, now, -1), -1)).toBe(1);
    expect(orderUnderHigh([t(0, 5)], now, -1)).toBe(now);
  });

  // Важную подняли через 5 с после обычной — зазор 5000 на масштабе
  // Date.now(): деление пополам упирается в точность double за пару десятков
  // новых. Тогда список перенумеровывается, и новая всё равно под важной.
  for (const dir of [1, -1] as const)
    it(`сотня новых подряд под важной — каждая сразу под ней (dir ${dir})`, () => {
      const at = 1_790_000_000_000;
      const list = dir === 1 ? [t(3, -at - 5000), t(0, -at)] : [t(3, at + 5000), t(0, at)];
      let renumbered = 0;
      for (let i = 0; i < 100; i++) {
        if (add(list, dir === 1 ? -at - 10_000 : at + 10_000, dir)) renumbered++;
        expect(list[0].priority).toBe(3);
        expect(list[1].id).toBe(`t${seq - 1}`);
        expect(new Set(list.map((x) => x.sortOrder)).size).toBe(list.length);
      }
      expect(renumbered).toBeGreaterThan(0);
    });
});
