import { describe, expect, it } from 'vitest';
import type { TaskPhoto } from '../db/types';
import { assembleBoard, BOARD_GAP, BOARD_ID, boardLayout, boardMaxHeight, gridLayout, type BoardLayout } from './photoBoard';

const W = 361; // ширина колонки на iPhone 14 Pro (393 − поля 2×16)
const H = boardMaxHeight(W);

/** Общие свойства любой раскладки: в границах, без наложений, плитка не
 *  меньше 44×44. */
function checkInvariants(layout: BoardLayout, n: number, maxH: number) {
  expect(layout.tiles).toHaveLength(n);
  expect(layout.height).toBeLessThanOrEqual(maxH);
  for (const a of layout.tiles) {
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.x + a.w).toBeLessThanOrEqual(W);
    expect(a.y + a.h).toBeLessThanOrEqual(layout.height);
    // Зона касания: по плитке тапают, расширить её за край некуда.
    expect(a.w).toBeGreaterThanOrEqual(44);
    expect(a.h).toBeGreaterThanOrEqual(44);
  }
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const a = layout.tiles[i];
      const b = layout.tiles[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart, `плитки ${i} и ${j} наложились`).toBe(true);
    }
}

describe('boardLayout — ряды по пропорциям', () => {
  it('одно горизонтальное фото — во всю ширину и в своих пропорциях', () => {
    const l = boardLayout([4 / 3], W, H);
    expect(l.tiles).toEqual([{ x: 0, y: 0, w: W, h: Math.floor(W / (4 / 3)) }]);
  });

  it('одно вертикальное — рамка во всю ширину, высота упирается в предел', () => {
    const l = boardLayout([3 / 4], W, H);
    expect(l.tiles).toEqual([{ x: 0, y: 0, w: W, h: H }]);
  });

  it('два горизонтальных — в один ряд, каждое в своих пропорциях', () => {
    const l = boardLayout([4 / 3, 4 / 3], W, H);
    expect(new Set(l.tiles.map((t) => t.y))).toEqual(new Set([0]));
    for (const t of l.tiles) expect(Math.abs(t.w / t.h - 4 / 3)).toBeLessThan(0.02);
    expect(l.tiles[1].x + l.tiles[1].w).toBe(W);
    expect(l.tiles[1].x - (l.tiles[0].x + l.tiles[0].w)).toBe(BOARD_GAP);
  });

  it('три горизонтальных — два ряда, а не три мелких в строку', () => {
    // В строку каждое было бы 116×87; рядами 2+1 — около 177×132.
    const l = boardLayout([4 / 3, 4 / 3, 4 / 3], W, H);
    expect(new Set(l.tiles.map((t) => t.y)).size).toBe(2);
    expect(Math.min(...l.tiles.map((t) => t.h))).toBeGreaterThan(120);
  });

  it('чем больше фото, тем мельче плитка', () => {
    const minSide = (n: number) => {
      const l = boardLayout(Array(n).fill(4 / 3), W, H);
      return Math.min(...l.tiles.map((t) => Math.min(t.w, t.h)));
    };
    expect(minSide(1)).toBeGreaterThan(minSide(2));
    expect(minSide(2)).toBeGreaterThanOrEqual(minSide(4));
    expect(minSide(4)).toBeGreaterThanOrEqual(minSide(9));
  });

  it('любой набор до 9 снимков: в границах, без наложений, снимок не режется', () => {
    const shapes = [4 / 3, 3 / 4, 16 / 9, 9 / 19.5, 1, 3 / 2, 2 / 3, 21 / 9];
    for (let n = 1; n <= 9; n++)
      for (let seed = 0; seed < shapes.length; seed++) {
        const aspects = Array.from({ length: n }, (_, i) => shapes[(seed + i * 3) % shapes.length]);
        const l = boardLayout(aspects, W, H);
        checkInvariants(l, n, H);
        // Рамка не уже снимка: если и отличается, то только вширь (подложка
        // по бокам), сверху и снизу снимок не обрезается и полос нет.
        l.tiles.forEach((t, i) => expect(t.w / t.h).toBeGreaterThanOrEqual(aspects[i] - 0.05));
      }
  });
});

describe('gridLayout — запасная ровная сетка', () => {
  it('до 9 снимков: в границах, без наложений', () => {
    for (let n = 1; n <= 9; n++) checkInvariants(gridLayout(Array(n).fill(3 / 4), W, H), n, H);
  });

  it('больше 9 (приехало синком с двух устройств) — сетка сразу, без перебора 2^(n−1)', () => {
    const t0 = performance.now();
    const l = boardLayout(Array(18).fill(4 / 3), W, H);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(l.tiles).toHaveLength(18);
    expect(l.height).toBeLessThanOrEqual(H);
  });
});

describe('assembleBoard', () => {
  const chunk = (photoId: string, createdAt: string, extra: Partial<TaskPhoto> = {}): TaskPhoto => ({
    id: `${photoId}_0`,
    taskId: BOARD_ID,
    photoId,
    idx: 0,
    total: 1,
    data: `data:image/jpeg;base64,${photoId}`,
    aspect: 1.5,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    ...extra,
  });

  it('порядок — по времени добавления, а не по хешу; удалённые и чужие не берутся', () => {
    const photos = assembleBoard([
      chunk('zzz', '2026-11-16T10:00:00.000Z'),
      chunk('aaa', '2026-11-16T12:00:00.000Z'),
      chunk('del', '2026-11-16T09:00:00.000Z', { deletedAt: '2026-11-16T13:00:00.000Z', data: '' }),
      chunk('task', '2026-11-16T08:00:00.000Z', { taskId: 'some-task-uuid' }),
    ]);
    expect(photos.map((p) => p.photoId)).toEqual(['zzz', 'aaa']);
    expect(photos[0].aspect).toBe(1.5);
  });
});
