import type { WorkoutExercise, WorkoutTemplateItem, WorkoutType } from '../../db/types';
import { workoutKind, type WorkoutKind } from './workouts';
import { cleanExercises } from './exercises';

// Строки формы одного вида — общие для тренировки и шаблона (ItemFields.tsx).

export interface ExerciseRow {
  key: string;
  name: string;
  sets: string;
  reps: string;
}

export interface Item {
  key: string;
  type: WorkoutType;
  customLabel: string | null;
  customColor: string | null;
  minutes: string;
  distance: string;
  minutesTouched: boolean;
  exercises: ExerciseRow[];
}

let keySeq = 0;
const nextKey = (prefix: string) => `${prefix}${++keySeq}`;

/** Новый вид. Без `minutes` — минуты по виду (тренировка в два касания) и
 *  подменяются при смене вида; с `minutes` — ровно они, и смена вида их не
 *  трогает (шаблон стартует с пустых минут). */
export function newItem(type: WorkoutType = 'run', minutes?: string): Item {
  return {
    key: nextKey('i'),
    type,
    customLabel: null,
    customColor: null,
    minutes: minutes ?? String(workoutKind(type).defaultMinutes),
    distance: '',
    minutesTouched: minutes !== undefined,
    exercises: [],
  };
}

/** Сохранённый вид (запись или строка шаблона) → строки формы. Минуты 0 —
 *  «не указано», в поле — пусто, а не «0». */
export function itemFromSaved(src: WorkoutTemplateItem): Item {
  return {
    key: nextKey('t'),
    type: src.type,
    customLabel: src.customLabel,
    customColor: src.customColor,
    minutes: src.minutes > 0 ? String(src.minutes) : '',
    distance: src.distanceKm != null ? String(src.distanceKm).replace('.', ',') : '',
    minutesTouched: true,
    exercises: (src.exercises ?? []).map(exerciseRow),
  };
}

export function exerciseRow(e: WorkoutExercise): ExerciseRow {
  return { key: nextKey('e'), name: e.name, sets: e.sets ? String(e.sets) : '', reps: e.reps ? String(e.reps) : '' };
}

export function kindOfItem(it: Pick<Item, 'type' | 'customLabel' | 'customColor'>): WorkoutKind {
  if (it.type === 'custom') {
    return { value: 'custom', label: it.customLabel ?? '', color: it.customColor ?? 'var(--lh-text-secondary)', hasDistance: false, defaultMinutes: 30 };
  }
  return workoutKind(it.type);
}

/** Строки формы → поля записи; общий кусок тренировки и шаблона. */
export function savedFromItem(it: Item): WorkoutTemplateItem {
  const k = kindOfItem(it);
  const dist = k.hasDistance ? Number(it.distance.replace(',', '.')) : 0;
  return {
    type: it.type,
    customLabel: it.type === 'custom' ? it.customLabel : null,
    customColor: it.type === 'custom' ? it.customColor : null,
    minutes: Math.round(Number(it.minutes.replace(',', '.')) || 0),
    distanceKm: k.hasDistance && dist > 0 ? Math.round(dist * 100) / 100 : null,
    exercises: cleanExercises(it.exercises),
  };
}
