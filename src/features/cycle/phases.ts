import { addDaysKey } from '../../lib/dates';

export type PhaseKind = 'period' | 'fertile' | 'plain';

/** Склеивает дни цикла в отрезки одной фазы для полосы на карточке «сейчас».
 *  Если цикл уже длиннее среднего, полоса растягивается до текущего дня —
 *  маркер не должен упираться в край, будто дальше ничего нет.
 *
 *  Менструация в прошедших днях — по факту: periodLen — длительность из
 *  текущего цикла (derive.ts: отрезок findPeriodRuns, с пропусками и без
 *  мазни), а не среднее. Среднее avgPeriodLen дорисовывает только сегодня и
 *  будущие дни, и только пока менструация не закончилась — последний её день
 *  отмечен сегодня или вчера (сегодня могли ещё не отметить). Иначе полоса
 *  показывает менструацию в дни, когда её не было, вразрез с календарём ниже. */
export function buildPhases(
  avgLen: number,
  periodLen: number,
  avgPeriodLen: number,
  start: string,
  fertile: Map<string, number>,
  currentDay?: number,
): { runs: { kind: PhaseKind; days: number }[]; total: number; marker: number } {
  const day = currentDay ?? 1;
  const total = Math.max(avgLen, day);
  const ongoing = periodLen >= day - 1;
  const runs: { kind: PhaseKind; days: number }[] = [];
  for (let i = 0; i < total; i++) {
    const kind: PhaseKind =
      i < periodLen || (ongoing && i < avgPeriodLen)
        ? 'period'
        : (fertile.get(addDaysKey(start, i)) ?? 0) > 0.15
          ? 'fertile'
          : 'plain';
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.days++;
    else runs.push({ kind, days: 1 });
  }
  return { runs, total, marker: ((day - 0.5) / total) * 100 };
}
