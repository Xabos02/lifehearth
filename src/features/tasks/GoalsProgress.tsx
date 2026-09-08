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

const RING = 36;
const STROKE = 3.5;

function Ring({ value, color }: { value: number; color: string }) {
  const r = (RING - STROKE) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} className="shrink-0" aria-hidden>
      <circle
        cx={RING / 2}
        cy={RING / 2}
        r={r}
        fill="none"
        stroke="var(--app-surface-2)"
        strokeWidth={STROKE}
      />
      {/* Поворот на -90°, чтобы дуга росла от 12 часов, а не от 3: снизу вверх
          читается как «наполняется», сбоку — как «крутится». */}
      <circle
        cx={RING / 2}
        cy={RING / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - (Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0) / 100)}
        transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
        className="transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
      />
    </svg>
  );
}

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

  return (
    <section className="mb-4" aria-label={t('Приближение к целям')}>
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex gap-2.5">
          {items.map(({ goal, linked, value, days }) => {
            const reached = value >= 100;
            const deadline = deadlineLabel(days);
            return (
              <Link
                key={goal.id}
                to={`/goals/${goal.id}`}
                // Ширина фиксированная: у карточек разной ширины лента
                // выглядит осыпавшейся, а край экрана перестаёт подсказывать,
                // что вправо есть ещё. 62% на 393px — следующая карточка
                // выглядывает ровно настолько, чтобы её захотелось подтянуть.
                className="card flex w-[min(62vw,15rem)] shrink-0 items-center gap-3 p-3 transition-transform active:scale-[0.98]"
              >
                <div className="relative shrink-0">
                  <Ring value={value} color={reached ? 'var(--app-success)' : goal.color} />
                  <span className="absolute inset-0 flex items-center justify-center">
                    {reached ? (
                      <GCheck size={ICON.action} className="text-success" strokeWidth={2.4} />
                    ) : (
                      <span className="text-2xs font-bold tabular-nums">{value}</span>
                    )}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-semibold">{goal.title}</p>
                  <p
                    className={`truncate text-xs ${reached ? 'text-success' : 'text-muted'}`}
                  >
                    {remainingLabel(goal, linked, value)}
                  </p>
                  {!reached && deadline && (
                    <p
                      className={`truncate text-xs font-medium ${
                        deadline.tone === 'danger' ? 'text-danger' : 'text-warning'
                      }`}
                    >
                      {deadline.text}
                    </p>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
