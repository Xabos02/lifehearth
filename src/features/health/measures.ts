import { db } from '../../db/db';
import { createWithId, remove, update } from '../../db/repo';
import type { MetricLog } from '../../db/types';
import { addDaysKey } from '../../lib/dates';
import { updateSettings } from '../../hooks/useSettings';

// Замеры вкладки «Здоровье»: вес, сон, пульс покоя, давление.
//
// Хранятся в таблицах metrics / metricLogs — они давно есть в базе, синке и
// копии, но экраном не пользовались. Идентификаторы метрик заданы, а не
// случайны: два устройства заводят «вес» независимо, и с случайными id после
// синка было бы два веса. Это дневник, не диагностика: приложение показывает
// числа и тренд, выводов не делает.

export type MeasureKey = 'weight' | 'sleep' | 'pulse' | 'bpSys' | 'bpDia' | 'hemoglobin' | 'ferritin';

export interface MeasureDef {
  key: MeasureKey;
  id: string;
  title: string;
  unit: string;
  color: string;
  /** Точность хранения: до скольких знаков округляется введённое. */
  decimals: number;
  /** Разумные границы ввода — не медицинские, а от опечаток. */
  min: number;
  max: number;
  /** С чего начинать поле, если замеров ещё нет. */
  placeholder: number;
}

export const MEASURES: MeasureDef[] = [
  { key: 'weight', id: 'health:weight', title: 'Вес', unit: 'кг', color: 'var(--app-accent)', decimals: 1, min: 20, max: 300, placeholder: 75 },
  { key: 'sleep', id: 'health:sleep', title: 'Сон', unit: 'ч', color: 'var(--app-accent-2)', decimals: 2, min: 0, max: 24, placeholder: 7 },
  { key: 'pulse', id: 'health:pulse', title: 'Пульс покоя', unit: 'уд/мин', color: 'var(--app-success)', decimals: 0, min: 25, max: 220, placeholder: 60 },
  { key: 'bpSys', id: 'health:bp-sys', title: 'Давление верхнее', unit: 'мм рт. ст.', color: 'var(--app-warning)', decimals: 0, min: 60, max: 260, placeholder: 120 },
  { key: 'bpDia', id: 'health:bp-dia', title: 'Давление нижнее', unit: 'мм рт. ст.', color: 'var(--app-warning)', decimals: 0, min: 30, max: 160, placeholder: 80 },
  // Редкие, из анализов. Сравнивать с «нормой» приложение не берётся —
  // референсы у лабораторий разные; показывает предыдущее значение рядом.
  { key: 'hemoglobin', id: 'health:hemoglobin', title: 'Гемоглобин', unit: 'г/л', color: 'var(--focus-accent)', decimals: 0, min: 40, max: 250, placeholder: 130 },
  { key: 'ferritin', id: 'health:ferritin', title: 'Ферритин', unit: 'нг/мл', color: 'var(--focus-accent-2)', decimals: 0, min: 1, max: 2000, placeholder: 50 },
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

/** Id лога — из метрики и дня. Не случайный: вес, введённый утром на
 *  телефоне и вечером на ноутбуке до обмена, с случайными id стал бы двумя
 *  записями за один день после синка; с заданным — одной, побеждает более
 *  поздняя правка. */
export function measureLogId(metricId: string, date: string): string {
  return `${metricId}:${date}`;
}

/** Записать замер на день. Второй замер в тот же день заменяет первый —
 *  вес утром и вес вечером в одной клетке дневника только путают. Округление
 *  — по точности замера (decimals), чтобы в базу не уезжал 78,30000000000001. */
export async function logMeasure(key: MeasureKey, date: string, value: number): Promise<void> {
  const def = measureDef(key);
  const metricId = await ensureMetric(def);
  const v = Number(value.toFixed(def.decimals));
  const id = measureLogId(metricId, date);
  const same = await db.metricLogs.get(id);
  if (same) await update(db.metricLogs, id, { value: v, deletedAt: null } as never);
  else await createWithId(db.metricLogs, id, { metricId, date, value: v });
  await update(db.metrics, metricId, { currentValue: v });
  // Вес — ещё и в профиле: его читают «Главная» и ИМТ. Один источник правды
  // — дневник; профиль догоняет, если замер не старше последнего.
  if (key === 'weight') {
    const logs = (await db.metricLogs.where('metricId').equals(metricId).toArray()).filter((l) => !l.deletedAt);
    const latest = logs.reduce((m, l) => (l.date > m ? l.date : m), '');
    if (date >= latest) {
      const s = await db.settings.get('app');
      await updateSettings({ profile: { ...s?.profile, weightKg: v } });
    }
  }
}

export async function removeMeasureLog(id: string): Promise<void> {
  await remove(db.metricLogs, id);
}

export interface MeasureTrend {
  last: MetricLog | null;
  /** Разница с первым замером в окне 30 дней; null — сравнивать не с чем. */
  delta30: number | null;
  /** Разница с предыдущим замером, без окна — для редких (анализы). */
  deltaPrev: number | null;
  /** Среднее за последние 7 дней по дням с замерами, без округления —
   *  округляет показ (для сна это часы и минуты, и десятые давали «7 ч 18 м»). */
  avg7: number | null;
  /** Точки для линии за окно, по дате. */
  series: { date: string; value: number }[];
}

/** Тренд по живым замерам одной метрики. Один замер на день: если после
 *  синка на дату пришло два лога, берётся тот, что правили позже. Чистая
 *  функция — для юнитов. */
export function measureTrend(logs: MetricLog[], today: string, windowDays = 30): MeasureTrend {
  const byDate = new Map<string, MetricLog>();
  for (const l of logs) {
    if (l.deletedAt || l.date > today) continue;
    const have = byDate.get(l.date);
    if (!have || l.updatedAt > have.updatedAt) byDate.set(l.date, l);
  }
  const alive = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const last = alive.length ? alive[alive.length - 1] : null;
  const prev = alive.length >= 2 ? alive[alive.length - 2] : null;
  const from = addDaysKey(today, -(windowDays - 1));
  const series = alive.filter((l) => l.date >= from).map((l) => ({ date: l.date, value: l.value }));
  const delta30 = last && series.length >= 2 ? round1(last.value - series[0].value) : null;
  const deltaPrev = last && prev ? round1(last.value - prev.value) : null;
  const week = alive.filter((l) => l.date >= addDaysKey(today, -6));
  const avg7 = week.length ? week.reduce((s, l) => s + l.value, 0) / week.length : null;
  return { last, delta30, deltaPrev, avg7, series };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** «78,4» — число с нужным числом знаков и запятой. */
export function formatMeasure(value: number, def: MeasureDef): string {
  return value.toFixed(def.decimals).replace('.', ',');
}
