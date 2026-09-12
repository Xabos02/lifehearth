import { afterAll, describe, expect, it } from 'vitest';
import { monthGridKeys } from './dates';

// Сетка месяца в зонах с переводом часов. Node применяет process.env.TZ на
// лету — этим и пользуемся; после теста возвращаем исходную зону.
const TZ = process.env.TZ;
afterAll(() => {
  process.env.TZ = TZ;
});

describe('monthGridKeys — без дублей в сутки перевода часов', () => {
  it('Берлин, октябрь 2026: 35 уникальных дней, 26-е — понедельник пятой строки', () => {
    process.env.TZ = 'Europe/Berlin';
    const keys = monthGridKeys('2026-10-15').map((d) => d.key);
    expect(keys).toHaveLength(35);
    expect(new Set(keys).size).toBe(35);
    expect(keys[28]).toBe('2026-10-26');
  });

  it('Нью-Йорк, ноябрь 2026: 42 дня без повторов', () => {
    process.env.TZ = 'America/New_York';
    const keys = monthGridKeys('2026-11-15').map((d) => d.key);
    expect(keys).toHaveLength(42);
    expect(new Set(keys).size).toBe(42);
  });

  it('Москва, сентябрь 2026: 35 дней, первый — 31 августа, чужой месяц помечен', () => {
    process.env.TZ = 'Europe/Moscow';
    const grid = monthGridKeys('2026-09-12');
    expect(grid).toHaveLength(35);
    expect(grid[0]).toEqual({ key: '2026-08-31', inMonth: false });
    expect(grid[1]).toEqual({ key: '2026-09-01', inMonth: true });
  });
});
