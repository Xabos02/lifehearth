import { db } from '../../db/db';
import { create, createWithId, now, update } from '../../db/repo';
import type { MetricLog } from '../../db/types';
import { addDaysKey } from '../../lib/dates';

// Замеры вкладки «Здоровье»: вес, сон, пульс покоя, давление.
//
// Хранятся в таблицах metrics / metricLogs — они давно есть в базе, синке и
// копии, но экраном не пользовались. Идентификаторы метрик заданы, а не
// случайны: два устройства заводят «вес» независимо, и с случайными id после
// синка было бы два веса. Это дневник, не диагностика: приложение показывает
// числа и тренд, выводов не делает.

export type MeasureKey = 'weight' | 'sleep' | 'pulse' | 'bpSys' | 'bpDia';

export interface MeasureDef {
  key: MeasureKey;
  id: string;
  title: string;
  unit: string;
  color: string;
  /** Шаг кнопок ±. */
  step: number;
  decimals: number;
  /** Разумные границы ввода — не медицинские, а от опечаток. */
  min: number;
  max: number;
  /** С чего начинать поле, если замеров ещё нет. */
  placeholder: number;
}

export const MEASURES: MeasureDef[] = [
  { key: 'weight', id: 'health:weight', title: 'Вес', unit: 'кг', color: 'var(--app-accent)', step: 0.1, decimals: 1, min: 20, max: 300, placeholder: 75 },
  { key: 'sleep', id: 'health:sleep', title: 'Сон', unit: 'ч', color: 'var(--app-accent-2)', step: 0.5, decimals: 1, min: 0, max: 24, placeholder: 7 },
  { key: 'pulse', id: 'health:pulse', title: 'Пульс покоя', unit: 'уд/мин', color: 'var(--app-success)', step: 1, decimals: 0, min: 25, max: 220, placeholder: 60 },
  { key: 'bpSys', id: 'health:bp-sys', title: 'Давление верхнее', unit: 'мм рт. ст.', color: 'var(--app-warning)', step: 1, decimals: 0, min: 60, max: 260, placeholder: 120 },
  { key: 'bpDia', id: 'health:bp-dia', title: 'Давление нижнее', unit: 'мм рт. ст.', color: 'var(--app-warning)', step: 1, decimals: 0, min: 30, max: 160, placeholder: 80 },
];

export function measureDef(key: MeasureKey): MeasureDef {
  return MEASURES.find((m) => m.key === key)!;
}

/** Метрика под замер существует и жива; вернуть её id. */
async function ensureMetric(def: MeasureDef): Promise<string> {
  const have = await db.metrics.get(def.id);
  if (have && !have.deletedAt) return have.id;
  if (have) {
    await update(db.metrics, def.id, { deletedAt: null } as never);
    return def.id;
  }
  await createWithId(db.metrics, def.id, {
    title: def.title,
    unit: def.unit,
    currentValue: 0,
    targetValue: null,
    color: def.color,
    sortOrder: MEASURES.indexOf(def),
  });
  return def.id;
}

/** Записать замер на день. Второй замер в тот же день заменяет первый —
 *  вес утром и вес вечером в одной клетке дневника только путают. */
export async function logMeasure(key: MeasureKey, date: string, value: number): Promise<void> {
  const def = measureDef(key);
  const metricId = await ensureMetric(def);
  const same = (await db.metricLogs.where('metricId').equals(metricId).toArray()).find(
    (l) => l.date === date && !l.deletedAt,
  );
  if (same) await update(db.metricLogs, same.id, { value });
  else await create(db.metricLogs, { metricId, date, value });
  await update(db.metrics, metricId, { currentValue: value });
}

export async function removeMeasureLog(id: string): Promise<void> {
  await db.metricLogs.update(id, { deletedAt: now(), updatedAt: now() });
}

export interface MeasureTrend {
  last: MetricLog | null;
  /** Разница с первым замером в окне 30 дней; null — сравнивать не с чем. */
  delta30: number | null;
  /** Среднее за последние 7 дней по дням с замерами; null — их нет. */
  avg7: number | null;
  /** Точки для линии за окно, по дате. */
  series: { date: string; value: number }[];
}

/** Тренд по живым замерам одной метрики. Чистая функция — для юнитов. */
export function measureTrend(logs: MetricLog[], today: string, windowDays = 30): MeasureTrend {
  const alive = logs.filter((l) => !l.deletedAt && l.date <= today).sort((a, b) => a.date.localeCompare(b.date));
  const last = alive.length ? alive[alive.length - 1] : null;
  const from = addDaysKey(today, -(windowDays - 1));
  const series = alive.filter((l) => l.date >= from).map((l) => ({ date: l.date, value: l.value }));
  const delta30 = last && series.length >= 2 ? round1(last.value - series[0].value) : null;
  const week = alive.filter((l) => l.date >= addDaysKey(today, -6));
  const avg7 = week.length ? round1(week.reduce((s, l) => s + l.value, 0) / week.length) : null;
  return { last, delta30, avg7, series };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** «78,4» — число с нужным числом знаков и запятой. */
export function formatMeasure(value: number, def: MeasureDef): string {
  return value.toFixed(def.decimals).replace('.', ',');
}
