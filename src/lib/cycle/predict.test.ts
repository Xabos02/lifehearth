import { describe, expect, it } from 'vitest';
import {
  LUTEAL_PHASE_DAYS,
  estimateOvulation,
  fertilityMap,
  poolForPrediction,
  predictNextPeriod,
} from './predict';
import { daysBetween } from './derive';
import type { Cycle, CycleEpisode, LocalDate } from '../../db/cycleTypes';
import { addDaysKey } from '../dates';

const NOW = '2026-07-25T10:00:00.000Z';

/** Строит цепочку завершённых циклов заданных длин, начиная с start. */
function chain(start: LocalDate, lengths: number[], periodLen = 5): Cycle[] {
  const out: Cycle[] = [];
  let cursor = start;
  for (const len of lengths) {
    const end = addDaysKey(cursor, len - 1);
    out.push({
      startDate: cursor,
      endDate: end,
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
  // Текущий цикл — от него и считается прогноз.
  out.push({
    startDate: cursor,
    periodEndDate: addDaysKey(cursor, periodLen - 1),
    periodLengthDays: periodLen,
    status: 'current',
    excluded: 0,
    hasDataGaps: 0,
    startConfirmed: 0,
    derivedAt: NOW,
  });
  return out;
}

describe('poolForPrediction', () => {
  it('отбрасывает исключённые, текущий и неполные циклы', () => {
    const cycles = chain('2026-01-01', [28, 29, 27]);
    cycles[0].excluded = 1;
    cycles[1].hasDataGaps = 1;
    const { pool } = poolForPrediction(cycles);
    expect(pool.map((c) => c.startDate)).toEqual([cycles[2].startDate]);
  });

  it('подтверждённый пользователем цикл с пропусками остаётся в пуле', () => {
    const cycles = chain('2026-01-01', [28, 29]);
    cycles[0].hasDataGaps = 1;
    cycles[0].startConfirmed = 1;
    const { pool } = poolForPrediction(cycles);
    expect(pool).toHaveLength(2);
  });

  it('отбрасывает выбросы по длине, но не клинически короткие циклы', () => {
    const cycles = chain('2026-01-01', [22, 28, 29, 120]);
    const { pool, widened } = poolForPrediction(cycles);
    // 22 дня — короткий цикл, а не ошибка данных: остаётся.
    // 120 дней — пропущенная менструация: уходит.
    expect(pool.map((c) => c.lengthDays)).toEqual([22, 28, 29]);
    expect(widened).toBe(false);
  });

  it('расширяет фильтр, если по обычному отсеялась половина', () => {
    // У человека с длинными циклами обычный фильтр выбросил бы почти всё, и
    // прогноз не построился бы никогда.
    const cycles = chain('2026-01-01', [55, 60, 48, 52]);
    const { pool, widened } = poolForPrediction(cycles);
    expect(widened).toBe(true);
    expect(pool).toHaveLength(4);
  });

  it('исключает циклы, пересекающиеся с эпизодом', () => {
    const cycles = chain('2026-01-01', [28, 28, 28]);
    const episodes: CycleEpisode[] = [
      {
        id: 'e1',
        kind: 'pregnancy',
        startDate: '2026-02-01',
        endDate: '2026-02-20',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const { pool } = poolForPrediction(cycles, episodes);
    // Выпадает только средний цикл (01-29…02-25) — он накрывает эпизод.
    // Первый кончился до его начала, третий начался после его конца.
    expect(pool.map((c) => c.startDate)).toEqual(['2026-01-01', '2026-02-26']);
  });
});

describe('predictNextPeriod', () => {
  it('без данных прогноза нет', () => {
    const r = predictNextPeriod({ cycles: [], today: '2026-07-25' });
    expect(r.confidence).toBe('none');
    expect(r.predictedStart).toBeUndefined();
  });

  it('при одном-двух циклах честно помечает опору на популяционные данные', () => {
    const cycles = chain('2026-06-01', [28]);
    const r = predictNextPeriod({ cycles, today: '2026-07-05' });
    expect(r.confidence).toBe('population_prior');
    expect(r.nCyclesUsed).toBe(1);
    // Центр тянется к популяционным 29 дням, а не равен её единственным 28.
    expect(r.centerLength).toBeGreaterThan(28);
    expect(r.centerLength).toBeLessThan(29);
  });

  it('на стабильных циклах даёт узкий интервал и центр рядом с её длиной', () => {
    const cycles = chain('2026-01-01', [28, 28, 28, 28, 28, 28, 28, 28]);
    const last = cycles[cycles.length - 1].startDate;
    const r = predictNextPeriod({ cycles, today: addDaysKey(last, 10) });
    expect(r.confidence).toBe('normal');
    expect(Math.round(r.centerLength!)).toBe(28);
    // Прогноз — ровно через 28 дней от начала текущего цикла.
    expect(r.predictedStart).toBe(addDaysKey(last, 28));
    // Интервал не схлопывается в ноль даже при идеально ровных данных:
    // обещать нулевую погрешность нельзя.
    expect(daysBetween(r.lo80!, r.hi80!)).toBeGreaterThanOrEqual(2);
  });

  it('80-процентный интервал всегда шире 50-процентного', () => {
    const cycles = chain('2026-01-01', [26, 30, 28, 31, 27, 29]);
    const last = cycles[cycles.length - 1].startDate;
    const r = predictNextPeriod({ cycles, today: addDaysKey(last, 5) });
    expect(daysBetween(r.lo80!, r.hi80!)).toBeGreaterThan(daysBetween(r.lo50!, r.hi50!));
    expect(r.lo80! <= r.lo50!).toBe(true);
    expect(r.hi80! >= r.hi50!).toBe(true);
  });

  it('при большом разбросе понижает уверенность', () => {
    const cycles = chain('2026-01-01', [22, 40, 25, 38, 23, 41]);
    const last = cycles[cycles.length - 1].startDate;
    const r = predictNextPeriod({ cycles, today: addDaysKey(last, 5) });
    expect(r.confidence).toBe('very_wide');
  });

  it('замечает дрейф длины и расширяет интервал', () => {
    // Первые циклы короткие, последние заметно длиннее — перименопауза или
    // послеродовой период выглядят именно так.
    const steady = chain('2026-01-01', [27, 27, 27, 27, 27, 27]);
    const drifting = chain('2026-01-01', [27, 27, 27, 34, 35, 36]);
    const a = predictNextPeriod({
      cycles: steady,
      today: addDaysKey(steady[steady.length - 1].startDate, 5),
    });
    const b = predictNextPeriod({
      cycles: drifting,
      today: addDaysKey(drifting[drifting.length - 1].startDate, 5),
    });
    expect(b.drift).toBe(true);
    expect(a.drift).toBe(false);
    expect(b.sigma!).toBeGreaterThan(a.sigma!);
    // Центр смещён в сторону последних циклов, а не остался на медиане всех.
    expect(b.centerLength!).toBeGreaterThan(30);
  });

  it('называет ту причину широкого интервала, из-за которой он и широк', () => {
    const reason = (lengths: number[]) => {
      const cycles = chain('2026-01-01', lengths);
      const r = predictNextPeriod({
        cycles,
        today: addDaysKey(cycles[cycles.length - 1].startDate, 3),
      });
      return [r.confidence, r.wideBecause];
    };
    // Четыре ровных цикла: до шести разброс популяционный, и интервал широк
    // не из-за её длин — экран писал «циклы заметно разной длины».
    expect(reason([28, 28, 28, 28])).toEqual(['wide', 'few_cycles']);
    // σ > 5 при размахе в 8 дней: «разница больше двух недель» была неправдой.
    expect(reason([24, 32, 28, 24, 32, 28])).toEqual(['very_wide', 'variability']);
    expect(reason([22, 40, 25, 38, 23, 41])).toEqual(['very_wide', 'spread']);
    // Разброс свой маленький, широким интервал сделал сдвиг последних циклов.
    expect(reason([27, 27, 27, 30, 31, 31])).toEqual(['wide', 'drift']);
    expect(reason([26, 30, 28, 26, 30, 28])).toEqual(['wide', 'variability']);
    expect(reason([28, 28, 28, 28, 28, 28])).toEqual(['normal', undefined]);
  });

  it('внутри эпизода прогноза нет', () => {
    const cycles = chain('2026-01-01', [28, 28]);
    const last = cycles[cycles.length - 1].startDate;
    const episodes: CycleEpisode[] = [
      { id: 'e1', kind: 'pregnancy', startDate: last, createdAt: NOW, updatedAt: NOW },
    ];
    const r = predictNextPeriod({ cycles, episodes, today: addDaysKey(last, 30) });
    expect(r.confidence).toBe('none');
    expect(r.predictedStart).toBeUndefined();
  });

  it('считает превышение прогноза, но не называет его задержкой', () => {
    const cycles = chain('2026-01-01', [28, 28, 28, 28]);
    const last = cycles[cycles.length - 1].startDate;
    const r = predictNextPeriod({ cycles, today: addDaysKey(last, 33) });
    expect(r.daysPastPrediction).toBe(5);
    // До прогнозной даты счётчик остаётся нулевым, а не отрицательным.
    const early = predictNextPeriod({ cycles, today: addDaysKey(last, 20) });
    expect(early.daysPastPrediction).toBe(0);
  });
});

describe('estimateOvulation', () => {
  it('ставит овуляцию за 13 дней до прогноза', () => {
    const cycles = chain('2026-01-01', [28, 28, 28, 28, 28, 28]);
    const last = cycles[cycles.length - 1].startDate;
    const p = predictNextPeriod({ cycles, today: addDaysKey(last, 5) });
    const ov = estimateOvulation(p);
    expect(ov.basis).toBe('calendar');
    expect(daysBetween(ov.centerDate!, p.predictedStart!)).toBe(LUTEAL_PHASE_DAYS);
  });

  it('складывает неопределённости: оценка овуляции всегда шире прогноза', () => {
    const cycles = chain('2026-01-01', [27, 29, 28, 30, 26, 29]);
    const last = cycles[cycles.length - 1].startDate;
    const p = predictNextPeriod({ cycles, today: addDaysKey(last, 5) });
    const ov = estimateOvulation(p);
    expect(ov.sigma!).toBeGreaterThan(p.sigma!);
  });

  it('при очень большом разбросе овуляцию не показывает вообще', () => {
    const cycles = chain('2026-01-01', [22, 40, 25, 38, 23, 41]);
    const last = cycles[cycles.length - 1].startDate;
    const p = predictNextPeriod({ cycles, today: addDaysKey(last, 5) });
    const ov = estimateOvulation(p);
    expect(ov.basis).toBe('none');
    expect(ov.centerDate).toBeUndefined();
  });

  it('использует собственную длину лютеиновой фазы, если она наблюдалась', () => {
    const cycles = chain('2026-01-01', [28, 28, 28, 28, 28, 28]);
    const last = cycles[cycles.length - 1].startDate;
    const p = predictNextPeriod({ cycles, today: addDaysKey(last, 5) });
    const ov = estimateOvulation(p, [11, 11, 12]);
    expect(daysBetween(ov.centerDate!, p.predictedStart!)).toBe(11);
  });
});

describe('fertilityMap', () => {
  const cycles = chain('2026-01-01', [28, 28, 28, 28, 28, 28]);
  const last = cycles[cycles.length - 1].startDate;
  const p = predictNextPeriod({ cycles, today: addDaysKey(last, 5) });
  const ov = estimateOvulation(p);
  const map = fertilityMap(ov, last, 40);

  it('вероятность максимальна не позже дня овуляции', () => {
    const peak = map.reduce((a, b) => (b.probability > a.probability ? b : a));
    expect(peak.date <= ov.centerDate!).toBe(true);
  });

  it('окно заканчивается днём овуляции, а не тянется после', () => {
    const center = map.find((d) => d.date === ov.centerDate!)!;
    const after3 = map.find((d) => d.date === addDaysKey(ov.centerDate!, 3))!;
    const before3 = map.find((d) => d.date === addDaysKey(ov.centerDate!, -3))!;
    expect(after3.probability).toBeLessThan(center.probability);
    // За три дня ДО овуляции вероятность выше, чем через три дня ПОСЛЕ —
    // это и есть асимметрия окна по Wilcox.
    expect(before3.probability).toBeGreaterThan(after3.probability);
  });

  it('все вероятности лежат в 0..1', () => {
    for (const d of map) {
      expect(d.probability).toBeGreaterThanOrEqual(0);
      expect(d.probability).toBeLessThanOrEqual(1);
    }
  });

  it('чем шире неопределённость, тем более размазана карта', () => {
    const sharp = fertilityMap({ ...ov, sigma: 1 }, last, 40);
    const blurry = fertilityMap({ ...ov, sigma: 6 }, last, 40);
    const peakOf = (m: typeof map) => Math.max(...m.map((d) => d.probability));
    expect(peakOf(sharp)).toBeGreaterThan(peakOf(blurry));
  });

  it('без оценки овуляции карта пустая', () => {
    expect(fertilityMap({ basis: 'none' }, last, 10)).toEqual([]);
  });
});
