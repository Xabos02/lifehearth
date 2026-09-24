// Единая точка чтения данных раздела. Все экраны берут отсюда, чтобы прогноз
// и статистика считались один раз за рендер, а не в каждом компоненте заново.

import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import type { Cycle, CycleDayLog, CycleSettings } from '../../db/cycleTypes';
import { todayKey } from '../../lib/dates';
import { DEFAULT_CYCLE_SETTINGS } from '../../lib/cycle/cycleRepo';
import { cycleDayFor } from '../../lib/cycle/derive';
import { detectAnomalies, type Anomaly } from '../../lib/cycle/anomalies';
import {
  estimateOvulation,
  fertilityMap,
  predictNextPeriod,
  type CyclePredictionResult,
  type FertileDay,
  type OvulationEstimate,
} from '../../lib/cycle/predict';
import { forecastStats, predictionAccuracy, type Accuracy, type CycleStats } from '../../lib/cycle/stats';

export interface CycleData {
  /** undefined, пока Dexie не ответил: отличается от «данных нет». */
  loading: boolean;
  settings: CycleSettings;
  days: CycleDayLog[];
  dayByDate: Map<string, CycleDayLog>;
  cycles: Cycle[];
  today: string;
  currentDay?: number;
  prediction: CyclePredictionResult;
  ovulation: OvulationEstimate;
  fertile: Map<string, number>;
  /** По той же выборке, что и прогноз (forecastStats). */
  stats: CycleStats;
  /** Начала циклов этой выборки: завершённый цикл не отсюда — «не учитывается». */
  counted: Set<string>;
  accuracy: Accuracy;
  anomalies: Anomaly[];
  hasAnyData: boolean;
}

export function useCycleData(): CycleData {
  const today = todayKey();

  const settingsRow = useLiveQuery(() => db.cycleSettings.get('app'), []);
  const days = useLiveQuery(() => db.cycleDays.toArray(), []);
  const cycles = useLiveQuery(() => db.cycles.orderBy('startDate').toArray(), []);
  const episodes = useLiveQuery(() => db.cycleEpisodes.toArray(), []);
  const predictions = useLiveQuery(() => db.cyclePredictions.toArray(), []);

  const loading =
    settingsRow === undefined ||
    days === undefined ||
    cycles === undefined ||
    episodes === undefined;

  return useMemo(() => {
    // Значения по умолчанию собираются ВНУТРИ useMemo: снаружи это был бы
    // новый объект на каждый рендер, мемоизация сбрасывалась бы всегда, и
    // прогноз со статистикой считались бы заново без всякой причины.
    const settings: CycleSettings = settingsRow ?? {
      ...DEFAULT_CYCLE_SETTINGS,
      updatedAt: '1970-01-01T00:00:00.000Z',
    };
    const dayList = days ?? [];
    const cycleList = cycles ?? [];
    const episodeList = episodes ?? [];

    const prediction = predictNextPeriod({ cycles: cycleList, episodes: episodeList, today });
    const { stats, counted } = forecastStats(cycleList, episodeList);
    // Овуляция и фертильность считаются всегда, но показываются только там, где
    // их включили: скрывать данные на уровне отрисовки надёжнее, чем не считать,
    // — иначе включение настройки потребовало бы пересчёта в другом месте.
    const ovulation = estimateOvulation(prediction);
    const fertile = new Map<string, number>();
    if (settings.fertilityDisplay !== 'off') {
      const from = prediction.fromCycleStart ?? today;
      for (const d of fertilityMap(ovulation, from, 60) as FertileDay[]) {
        if (d.probability > 0.01) fertile.set(d.date, d.probability);
      }
    }

    return {
      loading,
      settings,
      days: dayList,
      dayByDate: new Map(dayList.map((d) => [d.date, d])),
      cycles: cycleList,
      today,
      currentDay: cycleDayFor(today, cycleList, episodeList),
      prediction,
      ovulation,
      fertile,
      stats,
      counted,
      accuracy: predictionAccuracy(predictions ?? []),
      anomalies: detectAnomalies({
        cycles: cycleList,
        days: dayList,
        episodes: episodeList,
        today,
        onSuppressiveMethod:
          settings.mode === 'contraception' &&
          settings.contraception?.regimen === 'continuous',
      }),
      hasAnyData: dayList.length > 0,
    };
  }, [days, cycles, episodes, predictions, settingsRow, loading, today]);
}
