import { describe, expect, it } from 'vitest';

// Значение кольца прогресса зажимается в 0..100, и NaN — тоже.
//
// Math.min/max с NaN дают NaN: он уезжал в strokeDashoffset, React писал в
// консоль «Received NaN», а кольцо рисовалось пустым ободом. Приходит NaN
// оттуда, где делят на ноль: цель без измеримого показателя, проект без задач.
// Логика зажима вынесена сюда, чтобы её можно было проверить без рендера.

/** Ровно то выражение, что стоит в ProgressRing. */
const clamp = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0);

describe('зажим значения кольца', () => {
  it('обычные значения проходят как есть', () => {
    expect(clamp(0)).toBe(0);
    expect(clamp(42)).toBe(42);
    expect(clamp(100)).toBe(100);
  });

  it('выход за границы срезается', () => {
    expect(clamp(-10)).toBe(0);
    expect(clamp(150)).toBe(100);
  });

  it('деление на ноль не рисует пустой обод', () => {
    expect(clamp(0 / 0)).toBe(0);
    expect(clamp(NaN)).toBe(0);
  });

  it('бесконечность — тоже не значение', () => {
    expect(clamp(Infinity)).toBe(0);
    expect(clamp(-Infinity)).toBe(0);
  });
});
