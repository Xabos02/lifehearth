import { describe, expect, it } from 'vitest';
import {
  closePrediction,
  cycleStats,
  forecastStats,
  predictionAccuracy,
  symptomFrequency,
} from './stats';
import { predictNextPeriod } from './predict';
import type { Cycle, CyclePrediction, LocalDate } from '../../db/cycleTypes';
import { addDaysKey } from '../dates';

const NOW = '2026-07-25T10:00:00.000Z';

function chain(start: LocalDate, lengths: number[], periodLen = 5): Cycle[] {
  const out: Cycle[] = [];
  let cursor = start;
  for (const len of lengths) {
    out.push({
      startDate: cursor,
      endDate: addDaysKey(cursor, len - 1),
      lengthDays: len,
      periodEndDate: addDaysKey(cursor, periodLen - 1),
      periodLengthDays: periodLen,
      status: 'complete',
      excluded: 0,
      hasDataGaps: 0,
      startConfirmed: 0,
      derivedAt: NOW,
    });
    cursor = addDaysKey(cursor, len);
  }
  return out;
}

const prediction = (
  forCycleStart: LocalDate,
  predicted: LocalDate,
  halfWidth: number,
): CyclePrediction => ({
  forCycleStart,
  predictedNextStart: predicted,
  lo50: addDaysKey(predicted, -1),
  hi50: addDaysKey(predicted, 1),
  lo80: addDaysKey(predicted, -halfWidth),
  hi80: addDaysKey(predicted, halfWidth),
  method: 'personal',
  nCyclesUsed: 6,
  sigmaUsed: 2,
  createdAt: NOW,
});

describe('cycleStats', () => {
  it('на пустых данных ничего не выдумывает', () => {
    expect(cycleStats([])).toEqual({ n: 0 });
  });

  it('считает средние, размах и вариабельность', () => {
    const s = cycleStats(chain('2026-01-01', [28, 30, 26, 29]));
    expect(s.n).toBe(4);
    expect(s.averageLength).toBe(28.3);
    expect(s.shortestLength).toBe(26);
    expect(s.longestLength).toBe(30);
    expect(s.spread).toBe(4);
    // Разницы соседних: |30−28|=2, |26−30|=4, |29−26|=3 → медиана 3.
    expect(s.variability).toBe(3);
  });

  it('не берёт в расчёт исключённые и текущий цикл', () => {
    const cycles = chain('2026-01-01', [28, 30, 26]);
    cycles[0].excluded = 1;
    cycles.push({
      startDate: '2026-03-25',
      status: 'current',
      excluded: 0,
      hasDataGaps: 0,
      startConfirmed: 0,
      derivedAt: NOW,
    });
    const s = cycleStats(cycles);
    expect(s.n).toBe(2);
    expect(s.averageLength).toBe(28);
  });

  it('берёт только последние N циклов', () => {
    const s = cycleStats(chain('2020-01-01', new Array(30).fill(28)), 12);
    expect(s.n).toBe(12);
  });
});

describe('forecastStats', () => {
  it('«в среднем» — по тем же циклам, что и прогноз, а выпавший виден как неучтённый', () => {
    // 65 дней — пропущенная менструация: derive помечает такой цикл
    // пропусками, прогноз его отбрасывает, а среднее раньше брало — и
    // рядом с прогнозом через 28 дней стояло «в среднем 37,5 дня».
    const cycles = chain('2026-01-01', [28, 29, 65, 28]);
    cycles[2].hasDataGaps = 1;
    cycles[2].status = 'needs_confirmation';

    const { stats, counted } = forecastStats(cycles);
    expect(stats.averageLength).toBe(28.3);
    expect(stats.n).toBe(predictNextPeriod({ cycles, today: '2026-06-01' }).nCyclesUsed);
    expect(counted.has(cycles[2].startDate)).toBe(false);
    expect(counted.size).toBe(3);
  });
});

describe('predictionAccuracy и closePrediction', () => {
  it('без замкнутых прогнозов ничего не утверждает', () => {
    expect(predictionAccuracy([prediction('2026-01-01', '2026-01-29', 3)])).toEqual({ n: 0 });
  });

  it('замыкает прогноз фактом и считает попадание в интервал', () => {
    const p = prediction('2026-01-01', '2026-01-29', 3);
    const hit = closePrediction(p, '2026-01-31');
    expect(hit!.errorDays).toBe(2);
    expect(hit!.hitIn80).toBe(1);

    const miss = closePrediction(p, '2026-02-05');
    expect(miss!.errorDays).toBe(7);
    expect(miss!.hitIn80).toBe(0);
  });

  it('уже замкнутый прогноз повторно не трогает', () => {
    const p = closePrediction(prediction('2026-01-01', '2026-01-29', 3), '2026-01-30')!;
    expect(closePrediction(p, '2026-02-10')).toBeUndefined();
  });

  it('считает среднюю ошибку, долю попаданий и систематический сдвиг', () => {
    const records = [
      closePrediction(prediction('2026-01-01', '2026-01-29', 3), '2026-01-31')!, // +2
      closePrediction(prediction('2026-02-01', '2026-03-01', 3), '2026-03-03')!, // +2
      closePrediction(prediction('2026-03-01', '2026-03-29', 3), '2026-04-05')!, // +7, мимо
      closePrediction(prediction('2026-04-01', '2026-04-29', 3), '2026-04-28')!, // −1
    ];
    const a = predictionAccuracy(records);
    expect(a.n).toBe(4);
    expect(a.mae).toBe(3);
    expect(a.hits).toBe(3);
    expect(a.hitRate).toBe(0.8);
    // Сдвиг положительный: прогноз систематически раньше факта. Именно это
    // отличает bias от MAE — постоянное смещение лечится одной константой.
    expect(a.bias).toBe(2.5);
  });
});

describe('symptomFrequency', () => {
  const cycles = chain('2026-01-01', [28, 28], 5);

  function days(withSymptomOn: LocalDate[]): { date: LocalDate; symptomKeys?: string[] }[] {
    const out: { date: LocalDate; symptomKeys?: string[] }[] = [];
    for (const c of cycles) {
      for (let i = 0; i < 28; i++) {
        const date = addDaysKey(c.startDate, i);
        out.push({ date, symptomKeys: withSymptomOn.includes(date) ? ['cramps'] : [] });
      }
    }
    return out;
  }

  it('сравнивает дни менструации с остальными', () => {
    // Спазмы в первые два дня каждой менструации.
    const marks = cycles.flatMap((c) => [c.startDate, addDaysKey(c.startDate, 1)]);
    const r = symptomFrequency('cramps', days(marks), cycles)!;
    expect(r.duringPeriod).toBeGreaterThan(r.otherDays);
    // 4 отметки из 10 дней менструации.
    expect(r.duringPeriod).toBe(0.4);
    expect(r.otherDays).toBe(0);
    // Число наблюдений обязано возвращаться: доля без него ничего не значит.
    expect(r.observations).toBe(56);
  });

  it('без данных не возвращает ничего вместо нулей', () => {
    expect(symptomFrequency('cramps', [], cycles)).toBeUndefined();
    expect(symptomFrequency('cramps', days([]), [])).toBeUndefined();
  });
});
