// Детекция отклонений цикла.
//
// Здесь главное противоречие всего исследования: одна и та же метрика (размах
// длин циклов) имеет порог ≥17 дней за полгода у Apple и ≤7–9 дней по возрасту
// у FIGO 2018. Разница больше чем вдвое. При этом больше 40% женщин имеют
// вариабельность выше 7 дней (Fehring 2006) — то есть по порогу FIGO флаг
// сработал бы почти у половины, и раздел превратился бы в генератор тревоги.
//
// Отсюда два уровня с разным поведением:
//   уровень 1 — пороги Apple, только они порождают заметные предупреждения;
//   уровень 2 — рамка FIGO, показывается молча, внутри статистики, как справка
//               «что считается типичным» рядом с её собственными числами.
//
// Пороги Apple НЕ называем клиническими: Apple нигде не заявляет клинической
// валидации. Это продуктовые пороги, отобранные производителем платформы по
// низкой доле ложных срабатываний на популяции в сотни миллионов человек.

import type { AgeBand, Cycle, CycleDayLog, CycleEpisode, LocalDate } from '../../db/cycleTypes';
import { addDaysKey } from '../dates';
import { daysBetween, overlapsEpisode } from './derive';
import { t, tPlur } from '../i18n';

// Числа в этих текстах — про здоровье, и читает их человек, а не машина.
// «21 дней» и «5 менструации» здесь были не опечаткой, а тремя багами подряд.
const DAYS = ['день', 'дня', 'дней'] as const;

export type AnomalyKind =
  | 'irregular'
  | 'infrequent'
  | 'prolonged'
  | 'intermenstrual'
  | 'amenorrhea'
  | 'heavy';

export interface Anomaly {
  kind: AnomalyKind;
  /** Короткая формулировка для карточки. Утвердительная, без диагноза и без
   *  повелительного наклонения: приложение сообщает наблюдение, а не ставит
   *  диагноз и не командует. */
  title: string;
  /** Чем именно это подтверждается в её данных — всегда с числами. Без них
   *  предупреждение читается как приговор неизвестно на каком основании. */
  detail: string;
  /** Стоит показать врачу. Не «срочно», не «опасно». */
  worthAsking: boolean;
}

/** Окно детекции — календарные месяцы, а не циклы.
 *
 *  Это не одно и то же, и в исходных источниках разница потеряна: при цикле в
 *  24 дня в полгода укладывается 7,6 цикла, при 38 днях — 4,8. Пороги Apple
 *  определены именно на окне «последние 6 месяцев», и при переносе на «последние
 *  6 циклов» перестают значить то, что значили. */
const WINDOW_DAYS = 183;

/** Размах длин циклов, с которого Apple считает цикл нерегулярным. */
const IRREGULAR_SPREAD = 17;
/** Кровотечение такой длины Apple считает затяжным. */
const PROLONGED_DAYS = 10;
/** Сколько раз затяжное кровотечение должно повториться в окне. */
const PROLONGED_MIN_TIMES = 2;
/** Менструаций за полгода, при которых Apple говорит о редких менструациях. */
const INFREQUENT_MAX = 2;

/** Отсутствие менструации, при котором стоит обратиться к врачу.
 *
 *  ВАЖНО: величина общеупотребительная, первоисточником в разборе НЕ
 *  подтверждена. Держим её здесь одним числом, чтобы заменить в одном месте,
 *  когда появится проверенный источник. */
const AMENORRHEA_DAYS = 90;

/** Норма FIGO 2018 — справочная рамка второго уровня. Возрастные пороги
 *  требуют возраста, а профиля мы не заводим: спрашиваем возрастную группу
 *  одним необязательным вопросом, без ответа берём самый мягкий порог. */
export const FIGO = {
  cycleMin: 24,
  cycleMax: 38,
  bleedingMaxDays: 8,
  spreadByAge: {
    under_18: 9,
    '18_25': 9,
    '26_41': 7,
    '42_45': 9,
    over_45: 9,
  } as Record<AgeBand, number>,
  /** Без указанной возрастной группы — самый мягкий порог. */
  spreadDefault: 9,
};

export interface AnomalyInput {
  cycles: Cycle[];
  days: CycleDayLog[];
  episodes?: CycleEpisode[];
  today: LocalDate;
  /** На подавляющих методах отсутствие менструаций — ожидаемый результат
   *  метода, а не отклонение. Предупреждения об этом подавляются. */
  onSuppressiveMethod?: boolean;
}

/** Считает подряд идущие дни, удовлетворяющие условию, максимальной длиной. */
function longestRun(days: CycleDayLog[], pred: (d: CycleDayLog) => boolean): number {
  let best = 0;
  let cur = 0;
  let prevDate: LocalDate | null = null;
  for (const d of days) {
    const contiguous = prevDate !== null && daysBetween(prevDate, d.date) === 1;
    if (pred(d)) {
      cur = contiguous ? cur + 1 : 1;
      best = Math.max(best, cur);
    } else {
      cur = 0;
    }
    prevDate = d.date;
  }
  return best;
}

export function detectAnomalies(input: AnomalyInput): Anomaly[] {
  const episodes = input.episodes ?? [];
  const from = addDaysKey(input.today, -WINDOW_DAYS);
  const out: Anomaly[] = [];

  const days = [...input.days]
    .filter((d) => d.date >= from && d.date <= input.today)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const inWindow = input.cycles.filter(
    (c) =>
      c.startDate >= from &&
      c.excluded === 0 &&
      !overlapsEpisode(c.startDate, c.endDate, episodes),
  );
  const complete = inWindow.filter((c) => c.lengthDays !== undefined);

  // --- Нерегулярные циклы ---
  if (complete.length >= 3) {
    const lens = complete.map((c) => c.lengthDays!);
    const spread = Math.max(...lens) - Math.min(...lens);
    if (spread >= IRREGULAR_SPREAD) {
      out.push({
        kind: 'irregular',
        title: t('Циклы заметно разной длины'),
        detail: t('За полгода самый короткий цикл {min}, самый длинный {max} — разница {spread}.', {
          min: tPlur(Math.min(...lens), DAYS),
          max: Math.max(...lens),
          spread: tPlur(spread, DAYS),
        }),
        worthAsking: true,
      });
    }
  }

  // --- Редкие менструации ---
  // Считаем менструации, а не циклы: цикл может быть текущим и незавершённым.
  const periodsInWindow = new Set(inWindow.map((c) => c.startDate)).size;
  const hasEpisode = episodes.some((e) => (e.endDate ?? input.today) >= from);
  // «Меньше обычного за полгода» — вывод об отсутствии, и он требует полгода
  // наблюдений. Без этого карточка появлялась после самой первой отметки: одно
  // начало за неделю учёта — начало истории, а не редкие менструации. День
  // без отметки — «нет данных», а не ноль (PROTOCOL.md §7.2).
  const firstMark = [...input.days.map((d) => d.date), ...input.cycles.map((c) => c.startDate)].sort()[0];
  if (
    firstMark !== undefined &&
    firstMark <= from &&
    periodsInWindow > 0 &&
    periodsInWindow <= INFREQUENT_MAX &&
    !input.onSuppressiveMethod &&
    !hasEpisode
  ) {
    out.push({
      kind: 'infrequent',
      title: t('Менструаций за полгода меньше обычного'),
      detail:
        periodsInWindow === 1
          ? t('За последние шесть месяцев отмечено одно начало менструации.')
          : t('За последние шесть месяцев отмечено {n} начала менструации.', {
              n: periodsInWindow,
            }),
      worthAsking: true,
    });
  }

  // --- Затяжные менструации ---
  // Считаем по дням light и выше: мазня в длительность не входит.
  const prolonged = inWindow.filter(
    (c) => (c.periodLengthDays ?? 0) >= PROLONGED_DAYS,
  ).length;
  if (prolonged >= PROLONGED_MIN_TIMES) {
    out.push({
      kind: 'prolonged',
      title: t('Долгие менструации'),
      detail: t('За полгода {n} длились {days} и дольше.', {
        n: tPlur(prolonged, ['менструация', 'менструации', 'менструаций']),
        days: tPlur(PROLONGED_DAYS, DAYS),
      }),
      worthAsking: true,
    });
  }

  // --- Стойкие межменструальные кровотечения ---
  // Ровно тот случай, ради которого мазня хранится отдельным значением шкалы:
  // внутри менструации она не значит ничего, вне — значит.
  const spottingCycles = new Set<LocalDate>();
  for (const d of days) {
    if (d.bleeding !== 'spotting') continue;
    const cycle = inWindow.find(
      (c) => d.date >= c.startDate && (c.endDate === undefined || d.date <= c.endDate),
    );
    if (!cycle) continue;
    // Внутри самой менструации и сразу после неё мазня ожидаема.
    if (cycle.periodEndDate !== undefined && d.date <= addDaysKey(cycle.periodEndDate, 1)) continue;
    spottingCycles.add(cycle.startDate);
  }
  if (spottingCycles.size >= 2) {
    out.push({
      kind: 'intermenstrual',
      title: t('Мажущие выделения между менструациями'),
      detail: t('Отмечены в {n} циклах за полгода, вне дней менструации.', {
        n: spottingCycles.size,
      }),
      worthAsking: true,
    });
  }

  // --- Отсутствие менструации ---
  const lastPeriod = [...input.cycles].sort((a, b) => (a.startDate < b.startDate ? -1 : 1)).pop();
  if (
    lastPeriod &&
    !input.onSuppressiveMethod &&
    !overlapsEpisode(lastPeriod.startDate, input.today, episodes)
  ) {
    const since = daysBetween(lastPeriod.startDate, input.today);
    if (since >= AMENORRHEA_DAYS) {
      out.push({
        kind: 'amenorrhea',
        title: t('Менструации нет три месяца'),
        detail: t('Последнее начало — {days} назад. Если беременность исключена, это повод показаться врачу.', {
          days: tPlur(since, DAYS),
        }),
        worthAsking: true,
      });
    }
  }

  // --- Обильное кровотечение ---
  // Объём никто не измеряет, поэтому только косвенно. Формулировка через
  // качество жизни, а не через миллилитры: FIGO даёт равноправным критерием
  // «любой объём, который мешает жить», и это единственный критерий, который
  // человек может применить к себе сам.
  const heavyCycles = inWindow.filter((c) => {
    const cycleDays = days.filter(
      (d) => d.date >= c.startDate && (c.periodEndDate === undefined || d.date <= c.periodEndDate),
    );
    return longestRun(cycleDays, (d) => d.bleeding === 'heavy') >= 3;
  }).length;
  if (inWindow.length >= 3 && heavyCycles >= 2) {
    out.push({
      kind: 'heavy',
      title: t('Обильные менструации'),
      detail: t('В {heavy} циклах из {total} было три и больше дней подряд с обильными выделениями. Если это мешает обычным делам или есть слабость — стоит проверить железо.', {
        heavy: heavyCycles,
        total: inWindow.length,
      }),
      worthAsking: true,
    });
  }

  return out;
}

/** Справка второго уровня: как её числа выглядят на фоне рамки FIGO.
 *  Никаких предупреждений — только цифры рядом с цифрами. */
export interface FigoComparison {
  cycleLengthTypical: boolean | null;
  spreadTypical: boolean | null;
  bleedingTypical: boolean | null;
  spreadThreshold: number;
}

export function compareToFigo(cycles: Cycle[], ageBand?: AgeBand): FigoComparison {
  const complete = cycles.filter((c) => c.excluded === 0 && c.lengthDays !== undefined);
  const lens = complete.map((c) => c.lengthDays!);
  const periods = complete.map((c) => c.periodLengthDays ?? 0).filter((v) => v > 0);
  const threshold = ageBand ? FIGO.spreadByAge[ageBand] : FIGO.spreadDefault;

  return {
    cycleLengthTypical:
      lens.length === 0 ? null : lens.every((l) => l >= FIGO.cycleMin && l <= FIGO.cycleMax),
    spreadTypical:
      lens.length < 2 ? null : Math.max(...lens) - Math.min(...lens) <= threshold,
    bleedingTypical:
      periods.length === 0 ? null : periods.every((p) => p <= FIGO.bleedingMaxDays),
    spreadThreshold: threshold,
  };
}
