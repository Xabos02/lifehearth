import { t } from '../../lib/i18n';
import type { WorkoutExercise, WorkoutType } from '../../db/types';

// Упражнения внутри вида тренировки: «Силовая» = отжимания 3 × 15, планка
// 3 × 60. Общие для формы тренировки, шаблона и строк списка (задача 38).

/** «Отжимания 3×15» / «Планка 60» / «Колесо 3 подх.» / «Махи». */
export function formatExercise(e: WorkoutExercise): string {
  if (e.sets && e.reps) return `${e.name} ${e.sets}×${e.reps}`;
  if (e.reps) return `${e.name} ${e.reps}`;
  if (e.sets) return `${e.name} ${e.sets} ${t('подх.')}`;
  return e.name;
}

/** Все упражнения вида одной строкой через « · »; нет упражнений — ''. */
export function formatExercises(list: WorkoutExercise[] | undefined): string {
  return (list ?? []).map(formatExercise).join(' · ');
}

/** Строки ввода → то, что хранится. Строка без имени выпадает молча: это
 *  недописанная строка, а не упражнение. Подходы и повторы — по желанию:
 *  пусто, ноль и мусор становятся null. */
export function cleanExercises(rows: { name: string; sets: string; reps: string }[]): WorkoutExercise[] {
  const num = (s: string) => {
    const n = Math.round(Number(s.trim()));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return rows
    .map((r) => ({ name: r.name.trim(), sets: num(r.sets), reps: num(r.reps) }))
    .filter((e) => e.name.length > 0);
}

interface Source {
  type: WorkoutType;
  customLabel: string | null;
  exercises?: WorkoutExercise[];
}

/** Что предложить чипом «+ Отжимания»: упражнения, которые уже встречались
 *  у ЭТОГО вида (у бега — свои, у силовой — свои), без тех, что уже в
 *  форме, без повторов по имени. `sources` — свежие первыми: подходы и
 *  повторы берутся с последнего раза. */
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
