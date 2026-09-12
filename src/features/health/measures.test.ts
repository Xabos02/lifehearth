import { describe, expect, it } from 'vitest';
import type { MetricLog } from '../../db/types';
import { formatMeasure, measureDef, measureTrend } from './measures';

function log(date: string, value: number, deletedAt: string | null = null): MetricLog {
  return { id: date + value, createdAt: date, updatedAt: date, deletedAt, metricId: 'health:weight', date, value };
}

describe('тренд замера', () => {
  it('без замеров — всё пусто', () => {
    expect(measureTrend([], '2026-09-12')).toEqual({ last: null, delta30: null, avg7: null, series: [] });
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
    expect(t.avg7).toBe(78.7); // (79 + 78.6 + 78.4) / 3
    expect(t.series.map((p) => p.value)).toEqual([79.6, 79, 78.6, 78.4]);
  });

  it('один замер — разницы нет, среднее есть', () => {
    const t = measureTrend([log('2026-09-12', 78.4)], '2026-09-12');
    expect(t.delta30).toBeNull();
    expect(t.avg7).toBe(78.4);
  });

  it('формат: запятая и знаки по определению', () => {
    expect(formatMeasure(78.44, measureDef('weight'))).toBe('78,4');
    expect(formatMeasure(58, measureDef('pulse'))).toBe('58');
  });
});
