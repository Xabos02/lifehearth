import type { WorkoutType } from '../../db/types';

// Справочник видов тренировок: подпись, есть ли дистанция, минуты по
// умолчанию (чтобы отметить занятие в два касания).
//
// Набор — от занятий владельца (бег, бокс на мешке, гири, отжимания/планка =
// силовая) плюс самое частое у остальных: ходьба, вело, плавание, растяжка.

export interface WorkoutKind {
  value: WorkoutType;
  label: string;
  hasDistance: boolean;
  defaultMinutes: number;
}

/** Цвет отметки тренировки — один на все виды (выбор владельца 16.11.2026,
 *  канва design/sport-color): кружок дня в календаре, точка в строках
 *  тренировок и на «Сегодня», полосы «по видам». До того у каждого вида был
 *  свой цвет. По умолчанию зелёный.
 *
 *  Только токены темы: hex из палитры проектов за темой не идёт, и зелёный
 *  #4ade80 на белой карточке светлой темы — 1.9:1. Замер кружка (16.11.2026,
 *  на карточке, второй поверхности и подложке барабана, обе темы) — не ниже
 *  4.11 при норме для графики 3. Не взяты: оранжевый «Бокса» и бирюза
 *  «Плавания» — в светлой 2.83 и 2.26 на подложке; янтарь — в тёмной его не
 *  отличить от золота. */
export const WORKOUT_COLORS = [
  { value: 'green', label: 'Зелёный', color: 'var(--app-success)' },
  { value: 'blue', label: 'Голубой', color: 'var(--app-frost)' },
  { value: 'violet', label: 'Фиолетовый', color: 'var(--app-accent-2)' },
  { value: 'gold', label: 'Золотой', color: 'var(--lh-accent)' },
  { value: 'red', label: 'Красный', color: 'var(--app-danger)' },
];

/** CSS-цвет отметки по сохранённому значению; незнакомое (старая копия,
 *  чужое устройство) и пустое — зелёный. */
export function workoutColor(value: string | undefined): string {
  return (WORKOUT_COLORS.find((c) => c.value === value) ?? WORKOUT_COLORS[0]).color;
}

/** У кого показывать темп мин/км: бег и ходьба. Вело и плавание — другие
 *  единицы (км/ч, мин/100 м), отдельно, если понадобится. */
export const PACE_TYPES: ReadonlySet<WorkoutType> = new Set(['run', 'walk']);

export const WORKOUT_KINDS: WorkoutKind[] = [
  { value: 'run', label: 'Бег', hasDistance: true, defaultMinutes: 30 },
  { value: 'strength', label: 'Силовая', hasDistance: false, defaultMinutes: 45 },
  { value: 'boxing', label: 'Бокс', hasDistance: false, defaultMinutes: 30 },
  { value: 'kettlebell', label: 'Гири', hasDistance: false, defaultMinutes: 30 },
  { value: 'stretch', label: 'Растяжка', hasDistance: false, defaultMinutes: 20 },
  { value: 'walk', label: 'Ходьба', hasDistance: true, defaultMinutes: 40 },
  { value: 'bike', label: 'Вело', hasDistance: true, defaultMinutes: 45 },
  { value: 'swim', label: 'Плавание', hasDistance: true, defaultMinutes: 40 },
  { value: 'other', label: 'Другое', hasDistance: false, defaultMinutes: 30 },
];

export function workoutKind(type: WorkoutType): WorkoutKind {
  return WORKOUT_KINDS.find((k) => k.value === type) ?? WORKOUT_KINDS[WORKOUT_KINDS.length - 1];
}

/** Палитра для своих упражнений — по кругу, чтобы у каждого нового имени была
 *  своя точка, а не серая «другое» для всех сразу. С 16.11.2026 точка у всех
 *  видов одного цвета (WORKOUT_COLORS), а этот цвет только пишется в запись и
 *  справочник — экран его не читает. */
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
 *  своего упражнения (type='custom') — название, сохранённое прямо в записи
 *  (без похода в exerciseDefs — они нужны только для подсказки при вводе). */
export function resolveKind(w: { type: WorkoutType; customLabel?: string | null }): WorkoutKind {
  if (w.type === 'custom' && w.customLabel) {
    return { value: 'custom', label: w.customLabel, hasDistance: false, defaultMinutes: 30 };
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
