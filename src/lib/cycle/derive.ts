// Вывод циклов из дневных записей. Чистые функции без Dexie и без Date.now():
// на вход — массив записей и правки пользователя, на выход — массив циклов.
// Так эту логику можно прогнать тестами на сотне сценариев, не поднимая базу.
//
// Главное правило раздела: источник истины — дневные записи, циклы всего лишь
// кэш. Поэтому пересчёт обязан быть идемпотентным (повторный запуск на тех же
// данных даёт тот же результат) и обязан переживать пользовательские правки —
// они приходят отдельным списком и накладываются поверх.

import type {
  Cycle,
  CycleDayLog,
  CycleEpisode,
  CycleOverride,
  LocalDate,
} from '../../db/cycleTypes';
import { MENSTRUAL_LEVELS } from '../../db/cycleTypes';
import { addDaysKey } from '../dates';

/** Разрыв, который ещё считается одной менструацией.
 *
 *  Один-два дня без кровотечения в середине менструации — обычное дело: то
 *  «мазня», которую не отметили, то просто день без записи. Если рвать
 *  менструацию на каждом таком дне, у человека вместо одного цикла появятся
 *  три коротких, и вся статистика поедет. Два дня — компромисс: три подряд
 *  чистых дня уже надёжно означают, что менструация закончилась. */
const PERIOD_GAP_TOLERANCE = 2;

/** Минимальное число дней между началами двух менструаций, чтобы считать их
 *  разными циклами.
 *
 *  Клиническая нижняя граница нормальной длины цикла — 21 день (FIGO). Всё,
 *  что короче, почти всегда означает не новый цикл, а межменструальное
 *  кровотечение или продолжение той же менструации после паузы. Ставим порог
 *  чуть ниже клинического: 21 день сам по себе — валидный короткий цикл, и
 *  отбрасывать его нельзя. */
const MIN_CYCLE_LENGTH = 15;

/** Аномально длинный интервал: внутри него почти наверняка пропущенная
 *  менструация, а не цикл длиной в квартал. Такой цикл помечаем
 *  hasDataGaps — прогноз его учитывать не должен, пока человек не подтвердит.
 *  Экспортируется для выборки прогноза (predict.ts, poolForPrediction): из
 *  двух видов пропусков длину цикла искажает только этот. */
export const SUSPICIOUS_CYCLE_LENGTH = 60;

const isMenstrual = (d: CycleDayLog): boolean =>
  d.bleeding !== undefined && MENSTRUAL_LEVELS.includes(d.bleeding);

/** Разница в днях между двумя календарными датами. Считается по UTC-полуночи:
 *  обе даты — чистые календарные, поэтому переход на летнее время на разницу
 *  не влияет (в отличие от разницы локальных Date, где сутки бывают по 23 ч). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const ms = Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z');
  return Math.round(ms / 86400000);
}

/** Попадает ли дата внутрь эпизода (беременность, подавление цикла и т.п.). */
export function inEpisode(date: LocalDate, episodes: CycleEpisode[]): CycleEpisode | undefined {
  return episodes.find((e) => date >= e.startDate && (e.endDate === undefined || date <= e.endDate));
}

/** Пересекается ли отрезок [from, to] хотя бы с одним эпизодом.
 *
 *  Проверять только начало и конец цикла недостаточно: короткий эпизод
 *  (например, экстренная контрацепция) может целиком лежать внутри цикла, не
 *  задевая ни одну из его границ, — и такой цикл всё равно нельзя считать
 *  обычным. to === undefined означает незавершённый цикл: он тянется в
 *  будущее, поэтому пересекается с любым эпизодом, начавшимся после from. */
export function overlapsEpisode(
  from: LocalDate,
  to: LocalDate | undefined,
  episodes: CycleEpisode[],
): CycleEpisode | undefined {
  return episodes.find((e) => {
    const startsBeforeEnd = to === undefined || e.startDate <= to;
    const endsAfterStart = e.endDate === undefined || e.endDate >= from;
    return startsBeforeEnd && endsAfterStart;
  });
}

interface PeriodRun {
  start: LocalDate;
  end: LocalDate;
  /** Внутри менструации были дни вообще без записей. */
  gaps: boolean;
}

/** Склеивает подряд идущие дни кровотечения в менструации.
 *
 *  Записи должны быть отсортированы по дате. Дни, которых в массиве нет,
 *  считаются днями без данных — они не прерывают менструацию, но помечают её
 *  как неполную. */
export function findPeriodRuns(days: CycleDayLog[]): PeriodRun[] {
  const runs: PeriodRun[] = [];
  let current: PeriodRun | null = null;
  /** Сколько дней подряд после последнего кровотечения не было менструации. */
  let dry = 0;
  let sawGap = false;

  for (const day of days) {
    if (current) {
      // Проверяем всё, что между предыдущим днём менструации и текущей записью:
      // пропущенные календарные дни — это дни без данных, а не сухие дни.
      const missing = daysBetween(current.end, day.date) - 1;
      if (missing > 0) {
        sawGap = true;
        dry += missing;
      }
    }

    if (isMenstrual(day)) {
      if (current && dry <= PERIOD_GAP_TOLERANCE) {
        current.end = day.date;
        current.gaps = current.gaps || sawGap;
        dry = 0;
        sawGap = false;
      } else {
        if (current) runs.push(current);
        current = { start: day.date, end: day.date, gaps: false };
        dry = 0;
        sawGap = false;
      }
      continue;
    }

    if (!current) continue;

    // Явное «кровотечения не было», мазня или любая другая запись без
    // менструального уровня — сухой день. Мазня тоже сухой: она не входит
    // в длительность менструации (см. комментарий к BleedingLevel).
    dry += 1;
    if (dry > PERIOD_GAP_TOLERANCE) {
      runs.push(current);
      current = null;
      dry = 0;
      sawGap = false;
    }
  }

  if (current) runs.push(current);
  return runs;
}

export interface DeriveInput {
  days: CycleDayLog[];
  overrides?: CycleOverride[];
  episodes?: CycleEpisode[];
  /** Сегодня — чтобы решить, завершён ли последний цикл. Передаётся снаружи:
   *  функция обязана быть чистой, иначе её нельзя протестировать. */
  today: LocalDate;
  /** Штамп пересчёта. Тоже снаружи — по той же причине. */
  now: string;
}

/** Пересчитывает циклы из дневных записей.
 *
 *  Возвращает полный список: вызывающий код заменяет содержимое таблицы
 *  целиком, а не пытается обновить точечно. Точечное обновление здесь —
 *  источник рассинхрона: правка одного дня в середине истории меняет границы
 *  сразу двух циклов, а иногда и всех последующих. */
export function deriveCycles(input: DeriveInput): Cycle[] {
  const { today, now } = input;
  const episodes = input.episodes ?? [];
  const overrides = new Map((input.overrides ?? []).map((o) => [o.startDate, o]));
  const days = [...input.days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const runs = findPeriodRuns(days);
  if (runs.length === 0) return [];

  // Менструации, начавшиеся слишком скоро после предыдущей, — это не новые
  // циклы. Присоединяем их к предыдущему как продолжение: длительность
  // менструации при этом не растягиваем, потому что между ними были сухие дни.
  const starts: PeriodRun[] = [];
  for (const run of runs) {
    const prev = starts[starts.length - 1];
    if (prev && daysBetween(prev.start, run.start) < MIN_CYCLE_LENGTH) {
      prev.gaps = prev.gaps || run.gaps;
      continue;
    }
    starts.push(run);
  }

  const cycles: Cycle[] = [];
  for (let i = 0; i < starts.length; i++) {
    const run = starts[i];
    const next = starts[i + 1];
    const isLast = next === undefined;

    const endDate = isLast ? undefined : addDaysKey(next.start, -1);
    const lengthDays = endDate === undefined ? undefined : daysBetween(run.start, next.start);

    const periodLengthDays = daysBetween(run.start, run.end) + 1;

    // Дыры внутри менструации плюс подозрительно длинный цикл: и то, и другое
    // означает «данным этого цикла верить нельзя», а не «цикл такой».
    const suspicious = lengthDays !== undefined && lengthDays >= SUSPICIOUS_CYCLE_LENGTH;
    const hasDataGaps: 0 | 1 = run.gaps || suspicious ? 1 : 0;

    // Цикл, пересекающийся с эпизодом, из статистики выпадает: во время
    // беременности или на подавляющем методе «цикл» — это не цикл. Именно
    // пересечение, а не попадание границ: короткий эпизод может лежать
    // целиком внутри цикла, не задев ни начала, ни конца.
    const episode = overlapsEpisode(run.start, endDate, episodes);

    const o = overrides.get(run.start);
    const excluded: 0 | 1 = o?.excluded ?? (episode ? 1 : 0);
    const excludeReason =
      o?.excludeReason ??
      (episode
        ? episode.kind === 'pregnancy'
          ? 'pregnancy'
          : episode.kind === 'loss'
            ? 'loss'
            : episode.kind === 'hormonal_suppression'
              ? 'hormonal_method'
              : 'user'
        : undefined);

    const status: Cycle['status'] = isLast
      ? 'current'
      : hasDataGaps && !(o?.startConfirmed ?? 0)
        ? 'needs_confirmation'
        : 'complete';

    cycles.push({
      startDate: run.start,
      ...(endDate !== undefined ? { endDate } : {}),
      ...(lengthDays !== undefined ? { lengthDays } : {}),
      periodEndDate: run.end,
      periodLengthDays,
      status,
      excluded,
      ...(excludeReason !== undefined ? { excludeReason } : {}),
      hasDataGaps,
      startConfirmed: o?.startConfirmed ?? 0,
      derivedAt: now,
    });
  }

  // Последний цикл может оказаться в прошлом: если менструация была год назад
  // и с тех пор ни одной записи, называть его «текущим» неправильно. Но и
  // завершать его нечем — следующей менструации не было. Оставляем current и
  // помечаем пропуски: интерпретация («задержка» или «данных нет») — дело
  // движка прогнозов, у которого есть эпизоды и режим.
  const last = cycles[cycles.length - 1];
  if (last && daysBetween(last.startDate, today) >= SUSPICIOUS_CYCLE_LENGTH) {
    last.hasDataGaps = 1;
  }

  return cycles;
}

/** День цикла для даты: 1 — первый день менструации.
 *  undefined, если дата вне известных циклов (раньше первой записи или внутри
 *  эпизода, где понятие дня цикла не имеет смысла). */
export function cycleDayFor(
  date: LocalDate,
  cycles: Cycle[],
  episodes: CycleEpisode[] = [],
): number | undefined {
  if (inEpisode(date, episodes)) return undefined;
  for (let i = cycles.length - 1; i >= 0; i--) {
    const c = cycles[i];
    if (date < c.startDate) continue;
    if (c.endDate !== undefined && date > c.endDate) continue;
    return daysBetween(c.startDate, date) + 1;
  }
  return undefined;
}
