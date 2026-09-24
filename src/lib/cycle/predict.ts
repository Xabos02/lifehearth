// Прогноз следующей менструации, оценка овуляции и карта фертильности.
// Чистые функции: на вход — список циклов, на выход — распределение.
//
// Рамка, из которой всё следует: приложение ничего не измеряет, оно оценивает
// по тому, что человек ввёл. Поэтому наружу отдаём не дату, а распределение —
// дата это уже способ показать распределение, и способ по умолчанию неверный.
// Отсюда же запрет на формулировку «±2 дня»: при σ около 2,2 это 68-процентный
// интервал, то есть каждый третий цикл окажется снаружи, а «±2» читается как
// «точно». Либо называем вероятность словами, либо не показываем интервал.

import type { Cycle, CycleEpisode, LocalDate } from '../../db/cycleTypes';
import { addDaysKey } from '../dates';
import { daysBetween, overlapsEpisode, SUSPICIOUS_CYCLE_LENGTH } from './derive';

/** Длина лютеиновой фазы по умолчанию.
 *
 *  Источники расходятся: у Flo ≈14, у Clue 13 в прогнозе и 14 в ретро-расчёте,
 *  в учебниках «около 14», а две крупнейшие эмпирические работы (Fehring 2006 и
 *  Bull 2019 на 612 613 овуляторных циклах) дают 12,4. Берём 13 как компромисс.
 *  Смещение относительно 12,4 — примерно полдня, на фоне общей погрешности
 *  оценки овуляции (±10 дней по 95-процентному интервалу) это шум. Важно другое:
 *  константа обязана быть одна и в одном месте. У Clue она разъехалась на две. */
export const LUTEAL_PHASE_DAYS = 13;

/** Разброс длины лютеиновой фазы. Выведен из 95-процентных диапазонов
 *  Fehring (8–17) и Bull (7–17): ширина около 10 дней ≈ 4σ. */
const SIGMA_LUTEAL = 2.4;

/** Популяционный приор. Нужен, пока своих циклов мало: без него первые два
 *  цикла дали бы либо отказ от прогноза, либо обещание точности, которой нет. */
const PRIOR_MEAN = 29; // Bull 2019: среднее 29,3
const PRIOR_SPREAD = 3; // разброс индивидуальных средних; выбран, не выведен
/** Внутрииндивидуальная SD длины цикла.
 *
 *  Здесь два конкурирующих числа: 3,4 (Fehring 2006, 141 женщина, отобранная
 *  выборка пользовательниц монитора фертильности) и 4,2 (Apple Women's Health
 *  Study 2023, миллионы самоотчётных циклов). Берём 4,2: наши пользователи —
 *  люди с приложением, а не участницы исследования фертильности. Цена: все
 *  интервалы примерно на четверть шире. Это движение в честную сторону. */
const POP_SIGMA = 4.2;

/** Статистический фильтр выбросов — НЕ клиническая норма.
 *
 *  Клиническая рамка FIGO (24–38 дней) используется только для справочных
 *  флагов в статистике и никогда для отбраковки: цикл в 22 дня это короткий
 *  цикл, а не ошибка данных. Задача этого фильтра одна — не дать единственному
 *  аномальному значению увести среднее. */
const OUTLIER_MIN = 19;
const OUTLIER_MAX = 45;
/** Если по обычному фильтру отсеялась половина и больше, значит фильтр не
 *  выбросы ловит, а нормальные для этого человека циклы. Расширяем и честно
 *  предупреждаем, что интервал будет широким. */
const WIDE_MIN = 15;
const WIDE_MAX = 90;

const Z_50 = 0.674;
const Z_80 = 1.282;

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export interface PredictInput {
  cycles: Cycle[];
  episodes?: CycleEpisode[];
  today: LocalDate;
}

export type PredictionConfidence =
  /** Своих данных нет вообще — прогноза не существует. */
  | 'none'
  /** Циклов один-два: считаем по популяционным данным, а не по её. */
  | 'population_prior'
  /** Есть свои данные, но разброс велик — только широкий интервал. */
  | 'wide'
  /** Разброс так велик, что овуляцию показывать нельзя ни в каком виде. */
  | 'very_wide'
  /** Обычный случай: два вложенных интервала. */
  | 'normal';

export interface CyclePredictionResult {
  confidence: PredictionConfidence;
  /** Центральная оценка. Показывать её одну как «дату месячных» нельзя. */
  predictedStart?: LocalDate;
  lo50?: LocalDate;
  hi50?: LocalDate;
  lo80?: LocalDate;
  hi80?: LocalDate;
  /** Оценка длины цикла после смешивания с приором. */
  centerLength?: number;
  sigma?: number;
  nCyclesUsed: number;
  /** Средняя длина последних трёх заметно отличается от средней за полгода:
   *  возраст, перименопауза, послеродовой период, смена образа жизни. */
  drift: boolean;
  /** Фильтр выбросов пришлось расширить — циклы очень разной длины. */
  widenedFilter: boolean;
  /** Дата начала цикла, от которой считался прогноз. */
  fromCycleStart?: LocalDate;
  /** Сколько дней прошло с начала текущего цикла. */
  currentDay?: number;
  /** Насколько прогноз просрочен (0, если ещё не наступил). Именно «сколько
   *  дней сверх ожидаемого», а не «задержка»: слово «задержка» подразумевает
   *  вывод, который приложение делать не вправе. */
  daysPastPrediction: number;
  /** Чем на самом деле расширен интервал (у wide и very_wide) — подпись
   *  обязана называть эту причину, а не одну на все случаи. Было: у трёх
   *  ровных циклов по 28 дней экран писал «циклы заметно разной длины», хотя
   *  до шести циклов разброс берётся популяционный (POP_SIGMA) и от её данных
   *  не зависит; «больше двух недель» писалось и тогда, когда very_wide дала
   *  σ > 5 при размахе меньше двух недель.
   *  spread — размах длин больше двух недель; few_cycles — своих циклов
   *  меньше шести, разброс популяционный; drift — последние циклы ушли от
   *  прежних, интервал расширен в 1,3 раза; variability — её собственный
   *  разброс (MAD). */
  wideBecause?: 'spread' | 'few_cycles' | 'drift' | 'variability';
}

/** Отбирает циклы, пригодные для расчёта.
 *
 *  Это выборка всего экрана раздела, а не только прогноза: по ней же считаются
 *  «в среднем», «Статистика», карточка о разной длине циклов и пометки «не
 *  учитывается» в обзоре года (stats.ts, forecastStats; anomalies.ts).
 *
 *  Пропуски в отметках выбрасывают цикл, только когда из-за них врёт сама
 *  длина: SUSPICIOUS_CYCLE_LENGTH и больше — почти наверняка не отмечена целая
 *  менструация (как цикл в 65 дней из двух настоящих). Неотмеченный день
 *  внутри менструации длину не меняет — она считается от начала до начала.
 *  Было: выпадал любой цикл с hasDataGaps, и обычный 28-дневный цикл с одним
 *  забытым днём уходил из «Статистики» с пометкой «не учитывается» без видимой
 *  причины, а подтвердить его в интерфейсе нечем. */
export function poolForPrediction(
  cycles: Cycle[],
  episodes: CycleEpisode[] = [],
): { pool: Cycle[]; widened: boolean } {
  const base = cycles.filter(
    (c) =>
      c.status !== 'current' &&
      c.excluded === 0 &&
      c.lengthDays !== undefined &&
      (c.hasDataGaps === 0 || c.startConfirmed === 1 || c.lengthDays < SUSPICIOUS_CYCLE_LENGTH) &&
      !overlapsEpisode(c.startDate, c.endDate, episodes),
  );
  const narrow = base.filter(
    (c) => c.lengthDays! >= OUTLIER_MIN && c.lengthDays! <= OUTLIER_MAX,
  );
  if (base.length > 0 && narrow.length <= base.length / 2) {
    return {
      pool: base.filter((c) => c.lengthDays! >= WIDE_MIN && c.lengthDays! <= WIDE_MAX),
      widened: true,
    };
  }
  return { pool: narrow, widened: false };
}

export function predictNextPeriod(input: PredictInput): CyclePredictionResult {
  const episodes = input.episodes ?? [];
  const sorted = [...input.cycles].sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  const current = sorted[sorted.length - 1];

  const { pool, widened } = poolForPrediction(sorted, episodes);
  const lengths = pool.slice(-12).map((c) => c.lengthDays!);
  const n = lengths.length;

  const base = {
    nCyclesUsed: n,
    drift: false,
    widenedFilter: widened,
    daysPastPrediction: 0,
  };

  // Внутри эпизода прогноза нет по определению: во время беременности или на
  // подавляющем методе следующей менструации не «через 28 дней».
  if (current && overlapsEpisode(current.startDate, current.endDate, episodes)) {
    return { ...base, confidence: 'none' };
  }
  if (!current) return { ...base, confidence: 'none' };

  const currentDay = daysBetween(current.startDate, input.today) + 1;

  if (n === 0) {
    return { ...base, confidence: 'none', fromCycleStart: current.startDate, currentDay };
  }

  // Робастный центр: медиана устойчивее среднего к одному длинному циклу,
  // а такой цикл почти у каждого найдётся.
  const last6 = lengths.slice(-6);
  const m6 = median(last6);
  const last3 = lengths.slice(-3);
  const drift = n >= 6 && Math.abs(median(last3) - median(lengths)) > 2;
  const center = drift ? 0.6 * median(last3) + 0.4 * m6 : m6;

  // Робастный разброс. 1,4826 приводит MAD к σ нормального распределения.
  // Нижний клип 1,5 существует, чтобы не обещать невозможной точности: у
  // человека с тремя циклами ровно по 28 дней MAD = 0, и без клипа приложение
  // пообещало бы нулевую погрешность.
  const med = median(lengths);
  const mad = median(lengths.map((l) => Math.abs(l - med)));
  const sigmaHat = clamp(1.4826 * mad, 1.5, 9);
  const ownSigma = n >= 6;
  const sigmaEff = ownSigma ? sigmaHat : POP_SIGMA;

  // Нормально-нормальная сопряжённая схема: при малом n центр тянется к
  // популяционному, при большом — к её собственному. Двадцать строк вместо
  // ML-рантайма, и в отличие от него результат можно объяснить словами.
  const precisionData = n / (sigmaEff * sigmaEff);
  const precisionPrior = 1 / (PRIOR_SPREAD * PRIOR_SPREAD);
  const centerFinal =
    (precisionData * center + precisionPrior * PRIOR_MEAN) / (precisionData + precisionPrior);
  const varCenter = 1 / (precisionData + precisionPrior);
  let sigmaPred = Math.sqrt(sigmaEff * sigmaEff + varCenter);
  // Дрейф — заплатка, а не модель: формула предполагает постоянный центр,
  // а при тренде это неверно. Расширяем интервал, но честно называем это
  // компенсацией, а не учётом тренда.
  if (drift) sigmaPred *= 1.3;

  const offset = Math.round(centerFinal);
  const predictedStart = addDaysKey(current.startDate, offset);
  const d50 = Math.round(Z_50 * sigmaPred);
  const d80 = Math.round(Z_80 * sigmaPred);

  const spread = lengths.length > 1 ? Math.max(...lengths) - Math.min(...lengths) : 0;
  const overTwoWeeks = spread > 14;
  const confidence: PredictionConfidence =
    n <= 2
      ? 'population_prior'
      : sigmaPred > 5 || overTwoWeeks
        ? 'very_wide'
        : sigmaPred > 3
          ? 'wide'
          : 'normal';
  // Причина — из тех же величин, что и сама ширина. При n < 6 σ_pred ≈ 4,5
  // при любых её длинах (дрейфа там не бывает), поэтому «мало циклов» идёт
  // раньше дрейфа и разброса.
  const wideBecause =
    confidence !== 'wide' && confidence !== 'very_wide'
      ? undefined
      : overTwoWeeks
        ? 'spread'
        : !ownSigma
          ? 'few_cycles'
          : drift
            ? 'drift'
            : 'variability';

  const past = daysBetween(predictedStart, input.today);

  return {
    ...base,
    confidence,
    predictedStart,
    lo50: addDaysKey(predictedStart, -d50),
    hi50: addDaysKey(predictedStart, d50),
    lo80: addDaysKey(predictedStart, -d80),
    hi80: addDaysKey(predictedStart, d80),
    centerLength: centerFinal,
    sigma: sigmaPred,
    drift,
    fromCycleStart: current.startDate,
    currentDay,
    daysPastPrediction: past > 0 ? past : 0,
    ...(wideBecause ? { wideBecause } : {}),
  };
}

export interface OvulationEstimate {
  /** undefined, когда оценивать нечем или когда разброс так велик, что любая
   *  точка вводила бы в заблуждение. */
  centerDate?: LocalDate;
  sigma?: number;
  /** Оценка календарная (по прогнозу менструации) или подтверждена сигналом. */
  basis: 'none' | 'calendar' | 'lh_test' | 'bbt_shift';
}

/** Оценка дня овуляции.
 *
 *  Календарная оценка складывает две неопределённости: прогноза менструации и
 *  длины лютеиновой фазы. При типичном σ_pred = 4,3 получается σ ≈ 4,9, то есть
 *  95-процентный интервал около ±10 дней. Точкой такое рисовать нельзя ни при
 *  каких условиях — именно на этом ломаются конкуренты: из 53 проверенных
 *  приложений и сайтов (Setton 2016) фертильное окно верно предсказали четыре. */
export function estimateOvulation(
  prediction: CyclePredictionResult,
  observedLutealLengths: number[] = [],
): OvulationEstimate {
  if (prediction.predictedStart === undefined || prediction.sigma === undefined) {
    return { basis: 'none' };
  }
  if (prediction.confidence === 'very_wide') return { basis: 'none' };

  // Своя длина лютеиновой фазы, если овуляция подтверждалась хотя бы трижды:
  // она стабильнее фолликулярной, но «стабильнее» не значит «одинакова у всех».
  const lp =
    observedLutealLengths.length >= 3 ? median(observedLutealLengths) : LUTEAL_PHASE_DAYS;

  return {
    centerDate: addDaysKey(prediction.predictedStart, -Math.round(lp)),
    sigma: Math.sqrt(prediction.sigma * prediction.sigma + SIGMA_LUTEAL * SIGMA_LUTEAL),
    basis: 'calendar',
  };
}

/** Плотность стандартного нормального распределения. */
const phi = (z: number): number => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

export interface FertileDay {
  date: LocalDate;
  /** 0..1 — вероятность того, что этот день попадёт в фертильное окно. */
  probability: number;
}

/** Карта вероятности фертильных дней вместо плоской заливки.
 *
 *  Первоисточник — Wilcox 1995 (NEJM): зачатие происходило только при половом
 *  акте в шестидневном окне, ЗАКАНЧИВАЮЩЕМСЯ днём овуляции. Wilcox 2000 (BMJ)
 *  добавляет главное: лишь примерно у 30% женщин окно укладывается в учебниковые
 *  дни 10–17, а каждый день с 6-го по 21-й несёт не меньше 10% вероятности.
 *  Поэтому окно свёртывается с распределением дня овуляции: ширина полосы сама
 *  отражает неопределённость, а не притворяется, что её нет.
 *
 *  Границу берём строго по Wilcox — [овуляция−5, овуляция], без «плюс день
 *  после», который добавляют Flo и Clue. Свёртка и так даёт ненулевую
 *  вероятность правее центра.
 *
 *  Возвращает пустой массив, если оценивать нечем. Для контрацепции эти числа
 *  не годятся и в таком качестве не показываются никогда: у нас нет ни
 *  ежедневной базальной температуры, ни клиренса регулятора. */
export function fertilityMap(
  ovulation: OvulationEstimate,
  from: LocalDate,
  days: number,
): FertileDay[] {
  if (ovulation.centerDate === undefined || ovulation.sigma === undefined) return [];
  const sigma = ovulation.sigma;
  const out: FertileDay[] = [];

  for (let i = 0; i < days; i++) {
    const date = addDaysKey(from, i);
    const d = daysBetween(ovulation.centerDate, date);
    // Свёртка: суммируем вероятность того, что овуляция придётся на день k,
    // по всем k, при которых текущий день попадает в окно [k−5, k].
    let p = 0;
    let norm = 0;
    for (let k = -20; k <= 20; k++) {
      const w = phi(k / sigma);
      norm += w;
      if (d >= k - 5 && d <= k) p += w;
    }
    out.push({ date, probability: norm > 0 ? p / norm : 0 });
  }
  return out;
}
