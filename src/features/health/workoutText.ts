import { format } from 'date-fns';
import { t } from '../../lib/i18n';
import { addDaysKey, dateLocale, fromKey, weekStartKey } from '../../lib/dates';
import type { Workout } from '../../db/types';
import { workoutKind } from './workouts';
import type { TodayAdvice } from './workoutStats';

// Слова раздела «Спорт», общие для вкладки и строки на «Сегодня».

/** «сегодня» / «вчера» / «позавчера» / день недели на этой неделе / «5 сентября». */
export function relativeDay(date: string, today: string): string {
  if (date === today) return t('сегодня');
  if (date === addDaysKey(today, -1)) return t('вчера');
  if (date === addDaysKey(today, -2)) return t('позавчера');
  if (date >= weekStartKey(today)) return format(fromKey(date), 'EEEE', { locale: dateLocale() });
  return format(fromKey(date), 'd MMMM', { locale: dateLocale() });
}

/** «бег 5,2 км» / «гири». */
export function describeWorkout(w: Workout): string {
  const kind = workoutKind(w.type);
  const dist = w.distanceKm != null ? ` ${formatKm(w.distanceKm)}` : '';
  return `${t(kind.label).toLowerCase()}${dist}`;
}

export function formatKm(km: number): string {
  return `${km.toFixed(1).replace('.', ',')} ${t('км')}`;
}

export function adviceTitle(advice: TodayAdvice): string {
  // Без тире в первой: на 375px «Первая тренировка —» переносилось так, что
  // тире уезжало в начало второй строки.
  return {
    start: t('Первая тренировка сегодня?'),
    done: t('Сегодня уже была'),
    rest: t('Сегодня — отдых'),
    train: t('Сегодня — тренировка'),
  }[advice];
}

/** «Последняя — позавчера, бег 5,2 км» или приглашение к первой. */
export function lastLine(last: Workout | null, today: string): string {
  return last
    ? t('Последняя — {when}, {what}', { when: relativeDay(last.date, today), what: describeWorkout(last) })
    : t('Отметьте первую — и календарь начнёт считать ритм.');
}
