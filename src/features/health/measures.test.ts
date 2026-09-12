import { describe, expect, it } from 'vitest';
import type { MetricLog } from '../../db/types';
import { formatMeasure, measureDef, measureTrend } from './measures';

function log(date: string, value: number, deletedAt: string | null = null, updatedAt = date): MetricLog {
  return { id: date + value, createdAt: date, updatedAt, deletedAt, metricId: 'health:weight', date, value };
}

describe('тренд замера', () => {
  it('без замеров — всё пусто', () => {
    expect(measureTrend([], '2026-09-12')).toEqual({ last: null, delta30: null, deltaPrev: null, avg7: null, series: [] });
  });

  it('последний, разница за 30 дней, среднее за неделю; удалённые и будущие не считаются', () => {
    const logs = [
      log('2026-08-01', 80), // вне окна 30 дней
      log('2026-08-20', 79.6),
      log('2026-09-06', 79),
      log('2026-09-10', 78.6),
      log('2026-09-12', 78.4),
      log('2026-09-11', 70, '2026-09-11T10:00:00Z'), // удалён
      log('2026-09-20', 60), // будущее
    ];
    const t = measureTrend(logs, '2026-09-12');
    expect(t.last?.value).toBe(78.4);
    expect(t.delta30).toBe(-1.2); // 78.4 − 79.6
    expect(t.avg7).toBeCloseTo(78.6667, 3); // (79 + 78.6 + 78.4) / 3 — без округления
    expect(t.deltaPrev).toBe(-0.2); // 78.4 − 78.6
    expect(t.series.map((p) => p.value)).toEqual([79.6, 79, 78.6, 78.4]);
  });

  it('один замер — разницы нет, среднее есть', () => {
    const t = measureTrend([log('2026-09-12', 78.4)], '2026-09-12');
    expect(t.delta30).toBeNull();
    expect(t.avg7).toBe(78.4);
  });

  it('два лога на одну дату (синк с двух устройств) — побеждает правленный позже', () => {
    const logs = [
      log('2026-09-12', 80, null, '2026-09-12T08:00:00Z'),
      { ...log('2026-09-12', 78.4, null, '2026-09-12T20:00:00Z'), id: 'other-device' },
      log('2026-09-10', 79),
    ];
    const t = measureTrend(logs, '2026-09-12');
    expect(t.last?.value).toBe(78.4);
    expect(t.series).toHaveLength(2);
    expect(t.avg7).toBeCloseTo((79 + 78.4) / 2, 6);
  });

  it('среднее сна не теряет минуты: 7, 7,5, 7,5 → ровно 7 ч 20 м', () => {
    const t = measureTrend([log('2026-09-10', 7), log('2026-09-11', 7.5), log('2026-09-12', 7.5)], '2026-09-12');
    expect(Math.round((t.avg7! % 1) * 60)).toBe(20);
  });

  it('формат: запятая и знаки по определению', () => {
    expect(formatMeasure(78.44, measureDef('weight'))).toBe('78,4');
    expect(formatMeasure(58, measureDef('pulse'))).toBe('58');
  });
});
