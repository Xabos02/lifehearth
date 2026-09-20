import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { TaskCheck } from '../../components/ui/Checkbox';
import { ProgressRing } from '../../components/ui/ProgressRing';
import { todayKey } from '../../lib/dates';
import { isActiveOn, isLogDone } from '../../lib/habits';
import { useNavLayout } from '../../hooks/useNavLayout';
import { toggleHabitDone } from './habitRepo';
import { HabitLogSheet } from './HabitLogSheet';
import type { Habit, HabitLog } from '../../db/types';
import { t } from '../../lib/i18n';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';

/** Блок на «Сегодня»: запланированные на сегодня привычки с быстрой отметкой.
 *  Если на сегодня привычек нет — блок скрывается целиком (return null).
 *
 *  Скрытый раздел молчит: человек, выключивший «Привычки» в настройке
 *  разделов (выгорание, отпуск, «отстаньте все»), не должен каждый день
 *  видеть чек-лист на «Сегодня». Выключение раздела заодно замораживает все
 *  привычки разом (см. freezeAllForSection в habitRepo) — за паузу серии не
 *  сгорают, а isActiveOn ниже дополнительно прячет с «Сегодня» и привычки,
 *  замороженные вручную из шита. */
export function HabitsToday({ collapsed = false }: { collapsed?: boolean }) {
  const { hidden } = useNavLayout();
  const today = todayKey();
  const [logHabit, setLogHabit] = useState<Habit | null>(null);
  const habits = alive(useLiveQuery(() => db.habits.toArray(), []) ?? []).filter(
    (h) => !h.archivedAt,
  );
  const logs = alive(useLiveQuery(() => db.habitLogs.toArray(), []) ?? []);

  const todayLogByHabit = useMemo(() => {
    const m = new Map<string, HabitLog>();
    for (const l of logs) if (l.date === today) m.set(l.habitId, l);
    return m;
  }, [logs, today]);

  const planned = habits
    .filter((h) => isActiveOn(h, today))
    .sort((a, b) => a.sortOrder - b.sortOrder);


  const isDone = (h: Habit) => {
    const log = todayLogByHabit.get(h.id);
    return log ? isLogDone(h, log.value) : false;
  };
  const doneCount = planned.filter(isDone).length;

  // После хуков, не раньше: порядок хуков в React не может зависеть от условия.
  if (hidden.includes('habits')) return null;
  if (planned.length === 0) return null;
  // Всё на сегодня закрыто — счётчик показывает полоса дня, а список
  // сворачивается: галочки, по которым уже нечего нажимать, занимали место
  // до конца суток. Тап по ячейке полосы разворачивает обратно (open).
  //
  // Но только если список был закрыт УЖЕ при открытии экрана: снять галочку,
  // поставленную по ошибке, надо там же, где её поставили, а не после
  // разворачивания. Решение приходит сверху, от общего снимка дня.
  if (collapsed && doneCount === planned.length) return null;
  const logValue = logHabit ? (todayLogByHabit.get(logHabit.id)?.value ?? 0) : 0;

  return (
    <section className="mb-5">
      <h2 className="mb-2 flex items-center justify-between px-1 text-sm font-semibold text-muted">
        <span>{t('Привычки')}</span>
        <span className="text-xs font-normal">
          {doneCount}/{planned.length}
        </span>
      </h2>
      <div className="card divide-y divide-hairline px-4">
        {planned.map((h) => {
          const counted = h.target != null;
          const target = h.target ?? 0;
          const value = todayLogByHabit.get(h.id)?.value ?? 0;
          const done = isDone(h);
          const pct = counted && target > 0 ? Math.min(100, (value / target) * 100) : 0;
          return (
            <div
              key={h.id}
              onClick={() => {
                if (counted) setLogHabit(h);
                else void toggleHabitDone(h.id, today, !done);
              }}
              className="flex items-center gap-3 py-3 active:opacity-80"
            >
              <span className="text-lg leading-none" aria-hidden>
                {h.emoji}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`truncate ${done ? 'text-muted line-through' : 'font-medium'}`}>
                  {h.name}
                </p>
                {counted && (
                  <p className="mt-0.5 text-xs text-muted">
                    {value}/{target}
                    {h.unit ? ` ${h.unit}` : ''}
                  </p>
                )}
              </div>
              {counted ? (
                <button
                  type="button"
                  aria-label={t('Ввести значение')}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLogHabit(h);
                  }}
                  className={HIT_SLOP_44}
                >
                  <ProgressRing
                    value={pct}
                    size={40}
                    strokeWidth={4}
                    color={h.color}
                    label={done ? '✓' : `${value}`}
                  />
                </button>
              ) : (
                <TaskCheck
                  checked={done}
                  color={h.color}
                  onChange={() => void toggleHabitDone(h.id, today, !done)}
                />
              )}
            </div>
          );
        })}
      </div>
      <HabitLogSheet
        open={logHabit != null}
        onClose={() => setLogHabit(null)}
        habit={logHabit}
        date={today}
        currentValue={logValue}
      />
    </section>
  );
}
