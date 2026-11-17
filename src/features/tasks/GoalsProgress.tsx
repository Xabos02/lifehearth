import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { differenceInCalendarDays } from 'date-fns';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { Task } from '../../db/types';
import { fromKey } from '../../lib/dates';
import { goalProgress } from '../../lib/progress';
import { compareAhead, deadlineLabel, remainingLabel } from '../../lib/goalsAhead';
import { GCheck } from '../../components/ui/glyphs';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';

/**
 * Приближение к целям — лентой над списком задач.
 *
 * ЗАЧЕМ ЗДЕСЬ. Цели живут в своём разделе, и туда заходят раз в неделю. А
 * задачи открывают каждый день — и именно там теряется связь между «закрыл
 * восемь дел» и «стал ближе к тому, ради чего они». Лента возвращает эту
 * связь в место, куда человек и так смотрит.
 *
 * ПОЧЕМУ ЛЕНТА, А НЕ СПИСОК. Экран задач и без того плотный: строка быстрого
 * добавления, чипы тегов, папки. Вертикальный список целей отодвинул бы сами
 * задачи за первый экран — то есть ради напоминания о цели мешал бы к ней
 * идти. Горизонтальная лента занимает одну строку при любом числе целей.
 *
 * ЧТО ИМЕННО МОТИВИРУЕТ. Не процент — он абстрактен и на 62% выглядит так же,
 * как на 58%. Мотивирует ОСТАТОК: «осталось 3 задачи» — это дистанция, которую
 * видно и можно пройти сегодня. Процент оставлен как второй план, мелким.
 */

export function GoalsProgress() {
  const goalRows = useLiveQuery(() => db.goals.toArray(), []);
  const taskRows = useLiveQuery(() => db.tasks.toArray(), []);

  const goals = useMemo(
    () => alive(goalRows ?? []).filter((g) => g.status === 'active'),
    [goalRows],
  );

  // Все задачи одним запросом и группировка на месте: отдельный useLiveQuery на
  // каждую цель означал бы новую подписку на КАЖДУЮ цель, и они пересчитывались
  // бы при любой правке любой задачи.
  const byGoal = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of alive(taskRows ?? [])) {
      if (!task.goalId) continue;
      const arr = map.get(task.goalId);
      if (arr) arr.push(task);
      else map.set(task.goalId, [task]);
    }
    return map;
  }, [taskRows]);

  const items = useMemo(() => {
    const withProgress = goals.map((goal) => {
      const linked = byGoal.get(goal.id) ?? [];
      const value = goalProgress(goal, linked);
      const days = goal.targetDate
        ? differenceInCalendarDays(fromKey(goal.targetDate), new Date())
        : null;
      return { goal, linked, value, days };
    });
    return withProgress.sort(compareAhead);
  }, [goals, byGoal]);

  // Целей нет — блока нет. Пустая рамка с надписью «поставьте цель» на экране
  // задач была бы упрёком, а не помощью: человек пришёл сюда работать.
  if (items.length === 0) return null;

  // Макет «Задачи»: рубрика со ссылкой «Все цели», под ней карточки по две
  // в ряд — название и процент, тонкая полоса, остаток и срок мелко. Лента
  // осталась лентой (см. выше), просто карточка — ровно половина экрана.
  return (
    <section className="mb-5" aria-label={t('Приближение к целям')}>
      <div className="mb-2.5 flex items-center justify-between px-1">
        <h2 className="lh-section">{t('Приближение к целям')}</h2>
        <Link to="/goals" className={`text-xs text-lh-accent ${HIT_SLOP_44} relative`}>
          {t('Все цели')}
        </Link>
      </div>
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex gap-3">
          {items.map(({ goal, linked, value, days }) => {
            const reached = value >= 100;
            const deadline = deadlineLabel(days);
            const pct = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
            return (
              <Link
                key={goal.id}
                to={`/goals/${goal.id}`}
                className="card block w-[calc(50%-6px)] shrink-0 p-3.5 transition-transform active:scale-[0.98]"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 break-words text-xs text-lh-text-secondary">{goal.title}</span>
                  {reached ? (
                    <GCheck size={ICON.inline} className="shrink-0 text-success" strokeWidth={2.4} aria-label={t('Цель достигнута')} />
                  ) : (
                    <span className="shrink-0 text-xs font-semibold tabular-nums">{pct}%</span>
                  )}
                </div>
                <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-lh-surface-2" aria-hidden>
                  <div
                    className="h-1 rounded-full transition-[width] duration-500 motion-reduce:transition-none"
                    style={{ width: `${pct}%`, background: reached ? 'var(--app-success)' : goal.color || 'var(--lh-accent)' }}
                  />
                </div>
                <p className={`mt-2 text-2xs ${reached ? 'text-success' : 'text-lh-text-secondary'}`}>
                  {remainingLabel(goal, linked, value)}
                </p>
                {!reached && deadline && (
                  <p className={`text-2xs font-medium ${deadline.tone === 'danger' ? 'text-danger' : 'text-warning'}`}>
                    {deadline.text}
                  </p>
                )}
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
