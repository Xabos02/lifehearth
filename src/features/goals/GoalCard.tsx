import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { differenceInCalendarDays } from 'date-fns';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { Goal, Task } from '../../db/types';
import { fromKey } from '../../lib/dates';
import { goalCardDeadline } from '../../lib/goalsAhead';
import { goalProgress, goalProgressLabel } from '../../lib/progress';
import { ProgressRing } from '../../components/ui/ProgressRing';

/** Карточка цели — ссылка на детальную страницу, с кольцом прогресса и сроком. */
export function GoalCard({ goal }: { goal: Goal }) {
  // Для режима «по задачам» тянем живые связанные задачи сами.
  const linkedTasks =
    useLiveQuery(
      () =>
        goal.progressMode === 'tasks'
          ? db.tasks.where('goalId').equals(goal.id).toArray().then(alive)
          : Promise.resolve<Task[]>([]),
      [goal.id, goal.progressMode],
    ) ?? [];

  const value = goalProgress(goal, linkedTasks);
  const label = goalProgressLabel(goal, linkedTasks);

  const deadline = goal.targetDate
    ? goalCardDeadline(goal, differenceInCalendarDays(fromKey(goal.targetDate), new Date()), value)
    : null;

  return (
    <Link
      to={`/goals/${goal.id}`}
      className="card flex items-center gap-3.5 p-4 transition-transform active:scale-[0.99]"
    >
      <ProgressRing value={value} color={goal.color} />
      <div className="min-w-0 flex-1">
        {/* Заголовок цели длинный по смыслу, и на 320px под него остаётся всего
            ~179px (286 минус p-4 карточки, кольцо 56 и gap-3.5). Трёх строк там
            не хватило: реальная формулировка «Выйти на стабильный доход и
            закрыть все долги до конца года» при 17px раскладывается в пять строк
            (замер: scrollHeight 128 против clientHeight 77). Поэтому на узких
            экранах уменьшаем кегль до 15px — в строку входит ~22 символа вместо
            ~20 — и разрешаем четвёртую строку. От 380px и шире всё возвращается
            к исходным 17px и трём строкам. Карточка от лишней строки просто
            подрастает: кольцо, подпись прогресса и срок лежат в обычном потоке,
            наезжать друг на друга им нечем. */}
        <p className="line-clamp-4 break-words text-base font-semibold min-[380px]:line-clamp-3">
          {goal.title}
        </p>
        <p className="truncate text-sm text-muted">{label}</p>
        {deadline && (
          <p className={`text-xs ${deadline.danger ? 'text-danger' : 'text-muted'}`}>
            {deadline.text}
          </p>
        )}
      </div>
    </Link>
  );
}
