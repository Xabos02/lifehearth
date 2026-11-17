import type { Goal, Task } from '../db/types';
import { formatNum } from './finance';
import { t, tPlural } from './i18n';

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Прогресс цели 0..100 по её режиму. Для mode='tasks' передать связанные задачи. */
export function goalProgress(goal: Goal, linkedTasks: Task[] = []): number {
  switch (goal.progressMode) {
    case 'manual':
      return clamp(goal.progressManual);
    case 'numeric':
      return goal.targetValue
        ? clamp((100 * (goal.currentValue ?? 0)) / goal.targetValue)
        : 0;
    case 'tasks': {
      if (linkedTasks.length === 0) return 0;
      const done = linkedTasks.filter((t) => t.completedAt).length;
      return clamp((100 * done) / linkedTasks.length);
    }
  }
}

/** Подпись прогресса: «45%», «3 из 9 задач», «12 из 20 книг». */
export function goalProgressLabel(goal: Goal, linkedTasks: Task[] = []): string {
  switch (goal.progressMode) {
    case 'manual':
      return `${clamp(goal.progressManual)}%`;
    case 'numeric':
      return t('{a} из {b}{unit}', {
        a: formatNum(goal.currentValue ?? 0),
        b: formatNum(goal.targetValue ?? 0),
        unit: goal.unitLabel ? ` ${goal.unitLabel}` : '',
      });
    case 'tasks': {
      const done = linkedTasks.filter((task) => task.completedAt).length;
      return t('{a} из {b} {word}', {
        a: done,
        b: linkedTasks.length,
        word: tPlural(linkedTasks.length, ['задачи', 'задач', 'задач']),
      });
    }
  }
}

/** Полоска в строке «Выполненные» проекта: доля сделанных задач без повтора,
 *  0..100, или null — таких задач нет и показывать нечего.
 *
 *  Повторы не считаются. Отметка повтора оставляет выполненную запись и
 *  заводит новую копию: ежедневная задача за месяц дала бы 30 выполненных
 *  против одной живой, и полоска стояла бы на 97% при любом реальном
 *  продвижении (канва design/project-progress). Спящая задача ручного повтора
 *  лежит среди активных уже отмеченной — её отсекает тот же фильтр.
 *  Замороженные невыполненные не входят ни в один из списков экрана: на
 *  паузе — вне счёта, как и в «Статистике».
 *
 *  100% — только когда сделано всё, 0% — только когда ничего: при 199 из 200
 *  округление показало бы «100%» с задачей в списке. */
export function projectProgress(active: Task[], done: Task[]): number | null {
  const d = done.filter((task) => !task.recurrence).length;
  const total = d + active.filter((task) => !task.recurrence).length;
  if (!total) return null;
  if (d === total) return 100;
  if (d === 0) return 0;
  return Math.min(99, Math.max(1, Math.round((100 * d) / total)));
}
