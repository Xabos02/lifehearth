import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { todayKey } from '../../lib/dates';
import { t } from '../../lib/i18n';
import { useNavLayout } from '../../hooks/useNavLayout';
import { useSettings } from '../../hooks/useSettings';
import { GChevronRight as ChevronRight } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { DEFAULT_WEEKLY_GOAL, workoutKind } from './workouts';
import { formatMinutes, lastWorkout, todayAdvice, weekProgress } from './workoutStats';
import { adviceTitle, describeWorkout, relativeDay } from './workoutText';
import { WorkoutSheet } from './WorkoutSheet';

/** Строка спорта на «Сегодня»: что по ритму и кнопка отметить — одним
 *  жестом с главного экрана, как шкала энергии. «После каждой тренировки
 *  отмечать» переживает месяц, только если не надо идти в раздел.
 *
 *  Появляется после первой тренировки: новичку и семье, которым раздел не
 *  нужен, строка не навязывается. Скрытый раздел — молчит. */
export function SportTodayLine() {
  const { hidden } = useNavLayout();
  const settings = useSettings();
  const navigate = useNavigate();
  const today = todayKey();
  const rows = useLiveQuery(() => db.workouts.toArray(), []);
  const [open, setOpen] = useState(false);

  const workouts = alive(rows ?? []);
  const goal = settings.workoutWeeklyGoal ?? DEFAULT_WEEKLY_GOAL;
  const advice = todayAdvice(workouts, today, goal);
  const last = lastWorkout(workouts, today);
  const week = weekProgress(workouts, today, goal);

  if (hidden.includes('health')) return null;
  if (!rows || advice === 'start') return null;

  const done = advice === 'done' && last;
  const color = last ? workoutKind(last.type).color : 'var(--app-accent)';

  return (
    <section className="mb-5" data-testid="sport-today">
      <h2 className="mb-2 flex items-center justify-between px-1 text-sm font-semibold text-muted">
        <span>{t('Спорт')}</span>
        <span className="text-xs font-normal">{t('{done} из {goal} на неделе', { done: week.done, goal: week.goal })}</span>
      </h2>
      <div
        role={done ? 'button' : undefined}
        tabIndex={done ? 0 : undefined}
        onClick={done ? () => navigate('/more/health') : undefined}
        onKeyDown={
          done
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') navigate('/more/health');
              }
            : undefined
        }
        className={`card flex items-center gap-3 px-4 py-3 ${done ? 'active:opacity-80' : ''}`}
      >
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
        <span className="min-w-0 flex-1">
          {/* Без truncate: рядом с кнопкой заголовку остаётся ~180px, и
              «Сегодня — тренировка» резалось многоточием; перенос честнее. */}
          <span className="block font-semibold leading-tight">{adviceTitle(advice)}</span>
          <span className="block truncate text-xs text-muted">
            {done
              ? `${describeWorkout(last)} · ${formatMinutes(last.minutes, t)}`
              : last
                ? `${relativeDay(last.date, today)} · ${describeWorkout(last)}`
                : ''}
          </span>
        </span>
        {done ? (
          <ChevronRight size={ICON.base} className="shrink-0 text-muted" />
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={`shrink-0 rounded-full bg-accent-fill px-3.5 py-1.5 text-sm font-semibold text-white active:opacity-80 ${HIT_SLOP_44}`}
          >
            {t('Отметить')}
          </button>
        )}
      </div>
      <WorkoutSheet open={open} onClose={() => setOpen(false)} workout={null} date={today} />
    </section>
  );
}
