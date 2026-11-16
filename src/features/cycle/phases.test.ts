import { describe, expect, it } from 'vitest';
import { buildPhases } from './phases';

const none = new Map<string, number>();
const periodDays = (r: ReturnType<typeof buildPhases>) =>
  r.runs.filter((x) => x.kind === 'period').reduce((s, x) => s + x.days, 0);

describe('buildPhases: менструация на полосе — по факту, среднее только вперёд', () => {
  it('закончилась раньше средней — прошедшие дни не красятся по среднему', () => {
    // Средняя 6, отмечено 3 дня, сегодня 10-й.
    expect(periodDays(buildPhases(28, 3, 6, '2026-11-01', none, 10))).toBe(3);
  });

  it('идёт дольше средней — маркер «сегодня» внутри менструации', () => {
    // Средняя 5, кровотечение отмечено по сегодня, 7-й день.
    const r = buildPhases(28, 7, 5, '2026-11-01', none, 7);
    expect(periodDays(r)).toBe(7);
    expect(r.marker).toBeLessThan((7 / 28) * 100);
  });

  it('сегодня ещё не отмечено, вчера была — продолжение дорисовано средним', () => {
    expect(periodDays(buildPhases(28, 1, 5, '2026-11-01', none, 2))).toBe(5);
  });
});
