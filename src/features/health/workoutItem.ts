import type { ExerciseUnit, WorkoutExercise, WorkoutTemplateItem, WorkoutType } from '../../db/types';
import { workoutKind, type WorkoutKind } from './workouts';
import { cleanExercises } from './exercises';

// Строки формы одного вида — общие для тренировки и шаблона (ItemFields.tsx).

export interface ExerciseRow {
  key: string;
  name: string;
  sets: string;
  reps: string;
  /** Верхняя граница диапазона «6–8»; пусто — одно число. */
  repsTo: string;
  /** null — повторы. */
  unit: ExerciseUnit | null;
  weight: string;
  rest: string;
  note: string;
  /** Раскрыто для правки. Сохранённое упражнение читается строкой, новое
   *  пустое открыто сразу — в него сейчас будут писать. */
  open: boolean;
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
  /** Вид свёрнут до заголовка: чипы видов и минуты спрятаны. Так приходят
   *  виды из шаблона — их читают, а не выбирают; новый вид раскрыт. */
  collapsed: boolean;
  /** У записи есть километры, хотя у её вида дистанции нет: так приходит
   *  импорт («Другое» — лыжи 12,5 км). Поле показываем и км сохраняем, пока
   *  вид не сменили: иначе правка «как прошло» молча стирала дистанцию. */
  keepsDistance: boolean;
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
    collapsed: false,
    keepsDistance: false,
  };
}

/** Сохранённый вид (запись или строка шаблона) → строки формы. Минуты 0 —
 *  «не указано», в поле — пусто, а не «0». `collapsed` — вид из шаблона. */
export function itemFromSaved(src: WorkoutTemplateItem, collapsed = false): Item {
  return {
    key: nextKey('t'),
    type: src.type,
    customLabel: src.customLabel,
    customColor: src.customColor,
    minutes: src.minutes > 0 ? String(src.minutes) : '',
    distance: src.distanceKm != null ? String(src.distanceKm).replace('.', ',') : '',
    minutesTouched: true,
    exercises: (src.exercises ?? []).map((e) => exerciseRow(e)),
    collapsed,
    keepsDistance: src.distanceKm != null && !kindOfItem(src).hasDistance,
  };
}

/** Упражнение → строка формы. Без аргумента — пустая новая строка, сразу
 *  раскрытая; сохранённое и взятое подсказкой — свёрнуто, читается строкой. */
export function exerciseRow(e?: WorkoutExercise): ExerciseRow {
  return {
    key: nextKey('e'),
    name: e?.name ?? '',
    sets: e?.sets ? String(e.sets) : '',
    reps: e?.reps ? String(e.reps) : '',
    repsTo: e?.repsTo ? String(e.repsTo) : '',
    unit: e?.unit ?? null,
    weight: e?.weight ?? '',
    rest: e?.rest ?? '',
    note: e?.note ?? '',
    open: !e,
  };
}

export function kindOfItem(it: Pick<Item, 'type' | 'customLabel' | 'customColor'>): WorkoutKind {
  if (it.type === 'custom') {
    return { value: 'custom', label: it.customLabel ?? '', color: it.customColor ?? 'var(--lh-text-secondary)', hasDistance: false, defaultMinutes: 30 };
  }
  return workoutKind(it.type);
}

/** Строки формы → поля записи; общий кусок тренировки и шаблона. */
export function savedFromItem(it: Item): WorkoutTemplateItem {
  const hasDistance = kindOfItem(it).hasDistance || it.keepsDistance;
  const dist = hasDistance ? Number(it.distance.replace(',', '.')) : 0;
  return {
    type: it.type,
    customLabel: it.type === 'custom' ? it.customLabel : null,
    customColor: it.type === 'custom' ? it.customColor : null,
    minutes: Math.round(Number(it.minutes.replace(',', '.')) || 0),
    distanceKm: hasDistance && dist > 0 ? Math.round(dist * 100) / 100 : null,
    exercises: cleanExercises(it.exercises),
  };
}
