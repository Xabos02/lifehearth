// Статистика раздела и самокалибровка прогноза.
//
// Самокалибровка — то, чего нет ни у одного разобранного конкурента. Каждый
// прогноз сохраняется вместе с границами; когда цикл начинается, записывается
// факт и ошибка. Это закрывает главную дыру исследования: ни Flo, ни Clue не
// публикуют ни средней ошибки, ни покрытия интервалов, поэтому выбрать формулу
// по эмпирике было невозможно. Проверка переносится на устройство: через
// несколько циклов человек видит, насколько прогноз сбывается на ЕЁ данных.
//
// Побочный эффект принят сознательно: если формула плохая, это станет видно.
// Смягчать цифру нельзя — можно только объяснять, что разброс биологический.

import type { Cycle, CycleEpisode, CyclePrediction, LocalDate } from '../../db/cycleTypes';
import { daysBetween } from './derive';
import { poolForPrediction } from './predict';

export interface CycleStats {
  /** Сколько завершённых неисключённых циклов участвует в расчёте. */
  n: number;
  averageLength?: number;
  medianLength?: number;
  shortestLength?: number;
  longestLength?: number;
  /** Размах — та самая метрика, по которой расходятся Apple и FIGO. */
  spread?: number;
  /** Медиана модуля разницы соседних циклов: насколько цикл «скачет» от раза к
   *  разу. Устойчивее размаха, на который влияет один выброс. */
  variability?: number;
  averagePeriodLength?: number;
}

const median = (xs: number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const round1 = (v: number): number => Math.round(v * 10) / 10;

export function cycleStats(cycles: Cycle[], limit = 12): CycleStats {
  const pool = cycles
    .filter((c) => c.excluded === 0 && c.lengthDays !== undefined)
    .sort((a, b) => (a.startDate < b.startDate ? -1 : 1))
    .slice(-limit);

  const lens = pool.map((c) => c.lengthDays!);
  if (lens.length === 0) return { n: 0 };

  const periods = pool.map((c) => c.periodLengthDays ?? 0).filter((v) => v > 0);
  const diffs: number[] = [];
  for (let i = 1; i < lens.length; i++) {
    // Соседние — только идущие подряд. Если между ними выпал цикл (исключён,
    // длину исказила пропущенная отметка, выброс), разница двух несоседних —
    // уже не «скачок от раза к разу»: 40 и 28 через выпавший 65 давали 12.
    if (daysBetween(pool[i - 1].startDate, pool[i].startDate) !== lens[i - 1]) continue;
    diffs.push(Math.abs(lens[i] - lens[i - 1]));
  }

  return {
    n: lens.length,
    averageLength: round1(lens.reduce((a, b) => a + b, 0) / lens.length),
    medianLength: median(lens),
    shortestLength: Math.min(...lens),
    longestLength: Math.max(...lens),
    spread: Math.max(...lens) - Math.min(...lens),
    variability: diffs.length > 0 ? median(diffs) : undefined,
    averagePeriodLength:
      periods.length > 0 ? round1(periods.reduce((a, b) => a + b, 0) / periods.length) : undefined,
  };
}

/** Статистика экрана раздела — по той же выборке, что и прогноз.
 *
 *  «В среднем» стоит рядом с прогнозом, и считать их по разным выборкам
 *  нельзя: цикл в 65 дней с пропущенной менструацией прогноз отбрасывал
 *  (poolForPrediction: длина искажена пропуском, выброс по длине), а среднее
 *  тянуло вверх — «в среднем 37,5 дня» рядом с прогнозом через 28.
 *
 *  eligible — начала годных циклов, counted — тех, по которым посчитаны
 *  статистика и прогноз: последние 12 годных, как в predictNextPeriod. Было:
 *  counted = все годные, и при 15 циклах по 24 дня «Циклов учтено 12», а в
 *  обзоре года 14 циклов без единой пометки. По этим двум множествам цикл
 *  помечается «не учитывается», а годный старше последних 12 — с причиной.
 *  Отчёт для врача по-прежнему берёт cycleStats по всем циклам периода: там
 *  нужны отметки как есть. */
export function forecastStats(
  cycles: Cycle[],
  episodes: CycleEpisode[] = [],
): { stats: CycleStats; counted: Set<LocalDate>; eligible: Set<LocalDate> } {
  const { pool } = poolForPrediction(cycles, episodes);
  const sorted = [...pool].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  const used = sorted.slice(-12);
  return {
    stats: cycleStats(used),
    counted: new Set(used.map((c) => c.startDate)),
    eligible: new Set(sorted.map((c) => c.startDate)),
  };
}

export interface Accuracy {
  /** Сколько прогнозов уже можно сверить с фактом. */
  n: number;
  /** Средняя абсолютная ошибка в днях. */
  mae?: number;
  /** Сколько раз факт попал в обещанный 80-процентный интервал. */
  hits?: number;
  /** Доля попаданий. Если она сильно ниже 0,8 — интервалы слишком узкие, и это
   *  повод чинить формулу, а не прятать цифру. */
  hitRate?: number;
  /** Систематический сдвиг: прогноз в среднем раньше (минус) или позже (плюс)
   *  факта. Отличается от MAE тем, что не гасит знак — постоянный сдвиг видно
   *  сразу, и он лечится одной константой, а не переписыванием алгоритма. */
  bias?: number;
}

export function predictionAccuracy(records: CyclePrediction[]): Accuracy {
  const done = records.filter((r) => r.actualNextStart !== undefined);
  if (done.length === 0) return { n: 0 };

  const errors = done.map((r) => daysBetween(r.predictedNextStart, r.actualNextStart!));
  const hits = done.filter((r) => r.hitIn80 === 1).length;

  return {
    n: done.length,
    mae: round1(errors.reduce((a, b) => a + Math.abs(b), 0) / errors.length),
    hits,
    hitRate: round1(hits / done.length),
    bias: round1(errors.reduce((a, b) => a + b, 0) / errors.length),
  };
}

/** Замыкает прогноз фактом: вызывается, когда обнаружено начало нового цикла.
 *  Возвращает обновлённую запись либо undefined, если сверять нечего. */
export function closePrediction(
  record: CyclePrediction,
  actualNextStart: LocalDate,
): CyclePrediction | undefined {
  if (record.actualNextStart !== undefined) return undefined;
  const errorDays = daysBetween(record.predictedNextStart, actualNextStart);
  return {
    ...record,
    actualNextStart,
    errorDays,
    hitIn80: actualNextStart >= record.lo80 && actualNextStart <= record.hi80 ? 1 : 0,
  };
}

export interface SymptomByPhase {
  key: string;
  /** Средняя доля дней с симптомом в дни менструации. */
  duringPeriod: number;
  /** То же в остальные дни цикла. */
  otherDays: number;
  /** Сколько дней участвовало в расчёте — без этого числа доли ничего не значат. */
  observations: number;
}

/** Частота симптома в дни менструации против остальных дней.
 *
 *  Сознательно НЕ разбивается на четыре фазы и не считается по каждому симптому
 *  разом. Причина — множественные сравнения: если перебрать шесть фаз на десяти
 *  симптомах при трёх циклах данных, «закономерность» найдётся в чистом шуме.
 *  Крупные окна и по одному симптому за раз — та цена, которую платим за то,
 *  чтобы показанное было правдой. */
export function symptomFrequency(
  key: string,
  days: { date: LocalDate; symptomKeys?: string[] }[],
  cycles: Cycle[],
): SymptomByPhase | undefined {
  const pool = cycles.filter((c) => c.excluded === 0);
  if (pool.length === 0 || days.length === 0) return undefined;

  let periodDays = 0;
  let periodHits = 0;
  let otherDays = 0;
  let otherHits = 0;

  for (const d of days) {
    const cycle = pool.find(
      (c) => d.date >= c.startDate && (c.endDate === undefined || d.date <= c.endDate),
    );
    if (!cycle) continue;
    const inPeriod = cycle.periodEndDate !== undefined && d.date <= cycle.periodEndDate;
    const has = (d.symptomKeys ?? []).includes(key);
    if (inPeriod) {
      periodDays += 1;
      if (has) periodHits += 1;
    } else {
      otherDays += 1;
      if (has) otherHits += 1;
    }
  }

  if (periodDays === 0 || otherDays === 0) return undefined;
  return {
    key,
    duringPeriod: round1((100 * periodHits) / periodDays) / 100,
    otherDays: round1((100 * otherHits) / otherDays) / 100,
    observations: periodDays + otherDays,
  };
}
