import type { WorkoutType } from '../../db/types';

// Справочник видов тренировок: подпись, цвет точки в календаре, есть ли
// дистанция, минуты по умолчанию (чтобы отметить занятие в два касания).
//
// Набор — от занятий владельца (бег, бокс на мешке, гири, отжимания/планка =
// силовая) плюс самое частое у остальных: ходьба, вело, плавание, растяжка.
// Цвета — из палитры приложения, а не свои: точки стоят рядом с точками задач
// в календаре и должны выглядеть родными.

export interface WorkoutKind {
  value: WorkoutType;
  label: string;
  color: string;
  hasDistance: boolean;
  defaultMinutes: number;
}

/** У кого показывать темп мин/км: бег и ходьба. Вело и плавание — другие
 *  единицы (км/ч, мин/100 м), отдельно, если понадобится. */
export const PACE_TYPES: ReadonlySet<WorkoutType> = new Set(['run', 'walk']);

export const WORKOUT_KINDS: WorkoutKind[] = [
  { value: 'run', label: 'Бег', color: 'var(--app-accent)', hasDistance: true, defaultMinutes: 30 },
  { value: 'strength', label: 'Силовая', color: 'var(--focus-accent)', hasDistance: false, defaultMinutes: 45 },
  // Бокс — свой оранжевый, а не токен светлого конца фокуса: тот в светлой
  // теме на белой карточке давал 2,6:1, и точка тонула.
  { value: 'boxing', label: 'Бокс', color: 'oklch(0.66 0.19 45)', hasDistance: false, defaultMinutes: 30 },
  { value: 'kettlebell', label: 'Гири', color: 'var(--app-success)', hasDistance: false, defaultMinutes: 30 },
  { value: 'stretch', label: 'Растяжка', color: 'var(--app-accent-2)', hasDistance: false, defaultMinutes: 20 },
  { value: 'walk', label: 'Ходьба', color: 'var(--app-frost)', hasDistance: true, defaultMinutes: 40 },
  { value: 'bike', label: 'Вело', color: 'var(--app-warning)', hasDistance: true, defaultMinutes: 45 },
  // Плавание — бирюза, чтобы не совпадать с голубым ходьбы.
  { value: 'swim', label: 'Плавание', color: 'oklch(0.68 0.13 195)', hasDistance: true, defaultMinutes: 40 },
  { value: 'other', label: 'Другое', color: 'var(--app-muted)', hasDistance: false, defaultMinutes: 30 },
];

export function workoutKind(type: WorkoutType): WorkoutKind {
  return WORKOUT_KINDS.find((k) => k.value === type) ?? WORKOUT_KINDS[WORKOUT_KINDS.length - 1];
}

/** Палитра для своих упражнений — по кругу, чтобы у каждого нового имени была
 *  своя точка, а не серая «другое» для всех сразу. */
const CUSTOM_COLORS = [
  'var(--app-warning)',
  'oklch(0.66 0.19 45)',
  'var(--app-frost)',
  'oklch(0.68 0.13 195)',
  'var(--app-success)',
  'var(--focus-accent)',
];

export function nextCustomColor(existingCount: number): string {
  return CUSTOM_COLORS[existingCount % CUSTOM_COLORS.length];
}

/** Вид тренировки для конкретной записи: у встроенных — из справочника, у
 *  своего упражнения (type='custom') — название и цвет, сохранённые прямо в
 *  записи (без похода в exerciseDefs — они нужны только для подсказки при
 *  вводе). */
export function resolveKind(w: { type: WorkoutType; customLabel?: string | null; customColor?: string | null }): WorkoutKind {
  if (w.type === 'custom' && w.customLabel) {
    return {
      value: 'custom',
      label: w.customLabel,
      color: w.customColor ?? 'var(--app-muted)',
      hasDistance: false,
      defaultMinutes: 30,
    };
  }
  return workoutKind(w.type);
}

/** «Как прошло» — четыре слова вместо шкалы 1–10: по шкале люди не
 *  запоминают, что значила семёрка, а «тяжело» помнят. */
export const EFFORT_LABELS: { value: 1 | 2 | 3 | 4; label: string }[] = [
  { value: 1, label: 'Легко' },
  { value: 2, label: 'Нормально' },
  { value: 3, label: 'Тяжело' },
  { value: 4, label: 'На пределе' },
];

export const DEFAULT_WEEKLY_GOAL = 3;
