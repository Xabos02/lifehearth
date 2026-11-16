import { t } from '../../lib/i18n';
import type { ExerciseUnit, WorkoutExercise, WorkoutType } from '../../db/types';

// Упражнения внутри вида тренировки: «Силовая» = отжимания 3 × 15, планка
// 3 × 60. Общие для формы тренировки, шаблона и строк списка (задача 38).
// С 15.11.2026 — ещё диапазон «6–8», единицы (секунды, минуты, метры), вес,
// отдых и пометка: канва design/sport-templates, вариант Б.

/** В чём считается подход: чип в редакторе, подпись поля, приписка в строке.
 *  `null` — повторы: у них приписки нет, и в записи поля `unit` тоже нет. */
export const UNIT_OPTIONS: { value: ExerciseUnit | null; chip: string; field: string; short: string }[] = [
  { value: null, chip: 'повторы', field: 'Повторы', short: '' },
  { value: 'sec', chip: 'сек', field: 'Секунды', short: 'сек' },
  { value: 'min', chip: 'мин', field: 'Минуты', short: 'мин' },
  { value: 'm', chip: 'м', field: 'Метры', short: 'м' },
];

/** «4×6–8» / «3×30 сек» / «3 мин» / «15» / «3 подх.» / ''. `x` — знак между
 *  подходами и повторами: в строке списка вплотную, в редакторе — с пробелами. */
export function formatAmount(e: WorkoutExercise, x = '×'): string {
  const short = UNIT_OPTIONS.find((u) => u.value === (e.unit ?? null))?.short;
  const reps = e.reps ? `${e.reps}${e.repsTo ? `–${e.repsTo}` : ''}${short ? ` ${t(short)}` : ''}` : '';
  if (e.sets && reps) return `${e.sets}${x}${reps}`;
  if (reps) return reps;
  if (e.sets) return `${e.sets} ${t('подх.')}`;
  return '';
}

/** «Отжимания 3×15» / «Планка 60 сек» / «Колесо 3 подх.» / «Махи» /
 *  «Подтягивания 4×6–8, +12,5 кг» — вес в строке списка виден, отдых и
 *  пометка остаются в самой записи. */
export function formatExercise(e: WorkoutExercise): string {
  const head = [e.name, formatAmount(e)].filter(Boolean).join(' ');
  return e.weight ? `${head}, ${e.weight}` : head;
}

/** Все упражнения вида одной строкой через « · »; нет упражнений — ''. */
export function formatExercises(list: WorkoutExercise[] | undefined): string {
  return (list ?? []).map(formatExercise).join(' · ');
}

/** Строка ввода упражнения — всё текстом, как набрано в полях. */
export interface ExerciseInput {
  name: string;
  sets: string;
  reps: string;
  repsTo?: string;
  unit?: ExerciseUnit | null;
  weight?: string;
  rest?: string;
  note?: string;
}

/** Строки ввода → то, что хранится. Строка без имени выпадает молча: это
 *  недописанная строка, а не упражнение. Всё, кроме имени, — по желанию:
 *  пусто, ноль и мусор становятся null, а пустых новых полей в записи нет
 *  вовсе — упражнение «3 × 15» хранится так же, как до них. */
export function cleanExercises(rows: ExerciseInput[]): WorkoutExercise[] {
  const num = (s = '') => {
    const n = Math.round(Number(s.trim()));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return rows
    .map((r) => {
      // «8–6» и одна только верхняя граница — описки: границы встают по
      // порядку, одно число — просто число, без диапазона.
      const [lo, hi] = [num(r.reps), num(r.repsTo)].filter((n): n is number => n !== null).sort((a, b) => a - b);
      const out: WorkoutExercise = { name: r.name.trim(), sets: num(r.sets), reps: lo ?? null };
      if (hi !== undefined && hi !== lo) out.repsTo = hi;
      // Единица без числа ничего не значит.
      if (r.unit && out.reps) out.unit = r.unit;
      for (const k of ['weight', 'rest', 'note'] as const) {
        const v = r[k]?.trim();
        if (v) out[k] = v;
      }
      return out;
    })
    .filter((e) => e.name.length > 0);
}

interface Source {
  type: WorkoutType;
  customLabel: string | null;
  exercises?: WorkoutExercise[];
}

/** Что предложить чипом «+ Отжимания»: упражнения, которые уже встречались
 *  у ЭТОГО вида (у бега — свои, у силовой — свои), без тех, что уже в
 *  форме, без повторов по имени. `sources` — свежие первыми: подходы,
 *  повторы, вес и остальное берутся с последнего раза. */
export function exerciseSuggestions(
  sources: Source[],
  kind: { type: WorkoutType; customLabel: string | null },
  present: string[],
  limit = 5,
): WorkoutExercise[] {
  const seen = new Set(present.map((n) => n.trim().toLowerCase()));
  const out: WorkoutExercise[] = [];
  for (const s of sources) {
    if (s.type !== kind.type || (s.type === 'custom' && s.customLabel !== kind.customLabel)) continue;
    for (const e of s.exercises ?? []) {
      const key = e.name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(e);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
