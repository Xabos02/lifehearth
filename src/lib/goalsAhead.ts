// Что показывать в ленте «приближение к целям» над списком задач.
//
// Чистые функции отдельно от компонента: здесь склонения и порядок сортировки —
// ровно то, где ошибка не видна на глаз и живёт месяцами. Первая версия
// печатала «Осталось 3 3 задачи», потому что plur уже включает число в строку,
// а рядом стояло ещё одно. Такое ловится тестом за секунду и глазами — далеко
// не всегда.

import type { Goal, Task } from '../db/types';
import { getLang, t, tPlur } from './i18n';
import { plur, plural } from './plural';

/** Что осталось до цели — в единицах самой цели, а не в процентах.
 *
 *  Процент абстрактен: 62% выглядит так же, как 58%. «Осталось 3 задачи» —
 *  дистанция, которую видно и можно пройти сегодня. */
export function remainingLabel(goal: Goal, linked: Task[], value: number): string {
  if (value >= 100) return t('Цель достигнута');
  switch (goal.progressMode) {
    case 'tasks': {
      if (linked.length === 0) return t('Привяжите задачи');
      const left = linked.filter((task) => !task.completedAt).length;
      return t('Осталось {n}', { n: tPlur(left, ['задача', 'задачи', 'задач']) });
    }
    case 'numeric': {
      const left = Math.max(0, (goal.targetValue ?? 0) - (goal.currentValue ?? 0));
      return t('Осталось {n}', {
        n: `${Math.round(left)}${goal.unitLabel ? ` ${goal.unitLabel}` : ''}`,
      });
    }
    case 'manual':
      return t('Пройдено {v}%', { v: value });
  }
}

/** Подпись срока. null — срок не поджимает и показывать его не нужно.
 *
 *  Постоянная строка «осталось 214 дней» превращает срок в фон и заглушает те
 *  случаи, где он действительно значит «пора». */
export function deadlineLabel(days: number | null): { text: string; tone: 'warning' | 'danger' } | null {
  if (days === null) return null;
  if (days < 0) return { text: t('Срок прошёл'), tone: 'danger' };
  if (days === 0) return { text: t('Срок сегодня'), tone: 'warning' };
  if (days >= 7) return null;
  return { text: daysLeftText(days), tone: 'warning' };
}

/** Подпись срока на карточке в «Целях». null — подписи нет.
 *
 *  Не deadlineLabel: лента над задачами показывает срок, только когда он
 *  поджимает, а в «Цели» приходят смотреть на сами цели — там срок виден
 *  всегда, пока цель в работе. Раньше эта логика жила копией в карточке и
 *  разошлась с лентой: лента в день срока писала «Срок сегодня», карточка —
 *  «Осталось 0 дней». */
export function goalCardDeadline(goal: Goal, days: number): { text: string; danger: boolean } | null {
  // Завершённой и архивной цели срок уже ни о чём не говорит: красная
  // «Просрочена» у сделанного читалась как упрёк за то, что закрыто.
  if (goal.status === 'completed' || goal.status === 'archived') return null;
  if (days < 0) return { text: t('Просрочена'), danger: true };
  if (days === 0) return { text: t('Срок сегодня'), danger: true };
  return { text: daysLeftText(days), danger: days < 7 };
}

/** «Осталось 3 дня». Русское «Остался/Осталось» согласует род с числом —
 *  словарный ключ этого не выразит, английская фраза строится своей веткой. */
function daysLeftText(days: number): string {
  return getLang() === 'en'
    ? `${tPlur(days, ['день', 'дня', 'дней'])} left`
    : `${plural(days, ['Остался', 'Осталось', 'Осталось'])} ${plur(days, ['день', 'дня', 'дней'])}`;
}

/** Порядок в ленте: впереди то, что горит.
 *
 *  Цель со сроком идёт раньше бессрочной, среди срочных — ближайшая. Дальше по
 *  убыванию прогресса: почти взятая цель подталкивает сильнее, чем едва
 *  начатая. */
export function compareAhead(
  a: { days: number | null; value: number },
  b: { days: number | null; value: number },
): number {
  if (a.days !== null && b.days !== null) return a.days - b.days;
  if (a.days !== null) return -1;
  if (b.days !== null) return 1;
  return b.value - a.value;
}
