import { describe, expect, it } from 'vitest';
import { orderUnderHigh } from './taskOrder';

const TOP = -1_800_000_000_000;
const t = (priority: 0 | 3, sortOrder: number) => ({ priority, sortOrder });

/** Где встанет новая: индекс в списке после сортировки по направлению. */
function placed(list: ReturnType<typeof t>[], order: number, dir: 1 | -1 = 1): number {
  return [...list.map((x) => x.sortOrder), order].sort((a, b) => dir * (a - b)).indexOf(order);
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
    const o = orderUnderHigh(afterRaise, TOP);
    expect(placed(afterRaise, o)).toBe(1);
    expect(o).toBe(1_780_000_000_000 - 1000);
  });

  it('утащенная вниз важная в главу не входит', () => {
    const list = [t(3, 1000), t(0, 2000), t(3, 3000)];
    expect(placed(list, orderUnderHigh(list, TOP))).toBe(1);
  });

  it('одни важные — встаёт последней', () => {
    const list = [t(3, 1000), t(3, 2000)];
    expect(placed(list, orderUnderHigh(list, TOP))).toBe(2);
  });

  it('несколько новых подряд — каждая выше предыдущей, но под важными', () => {
    const list = [t(3, 1000), t(0, 2000)];
    for (let i = 0; i < 5; i++) {
      const o = orderUnderHigh(list, TOP);
      expect(placed(list, o)).toBe(1);
      list.push(t(0, o));
      list.sort((a, b) => a.sortOrder - b.sortOrder);
    }
  });

  it('семейный список по убыванию — то же самое зеркально', () => {
    const now = 1_790_000_000_000;
    const list = [t(3, now - 10), t(0, now - 20_000)];
    const o = orderUnderHigh(list, now, -1);
    expect(placed(list, o, -1)).toBe(1);
    expect(orderUnderHigh([t(0, 5)], now, -1)).toBe(now);
  });
});
