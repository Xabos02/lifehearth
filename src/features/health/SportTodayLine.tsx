import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router';
import { db } from '../../db/db';
import { todayKey } from '../../lib/dates';
import { t } from '../../lib/i18n';
import { useNavLayout } from '../../hooks/useNavLayout';
import { useSettings } from '../../hooks/useSettings';
import { GFaChevronRight as ChevronRight } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { DEFAULT_WEEKLY_GOAL, resolveKind } from './workouts';
import { formatMinutes, lastSessionLead, lastWorkout, todayAdvice, weekProgress } from './workoutStats';
import { adviceTitle, describeWorkout, relativeDay } from './workoutText';
import { WorkoutSheet } from './WorkoutSheet';
import { shownWorkouts } from './workoutRepo';

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
  // Дата формы — на нажатии «Отметить», а не из отрисовки: «Сегодня»
  // перерисовывается в полночь, и новая дата в ключе формы стирала набранное
  // (аудит 1.64.0, H4). Тот же приём, что в HealthPage.
  const [openOn, setOpenOn] = useState<string | null>(null);

  const workouts = useMemo(() => shownWorkouts(rows ?? []), [rows]);
  const goal = settings.workoutWeeklyGoal ?? DEFAULT_WEEKLY_GOAL;
  const advice = todayAdvice(workouts, today, goal);
  const last = lastWorkout(workouts, today);
  const week = weekProgress(workouts, today, goal);

  if (hidden.includes('health')) return null;
  if (!rows || advice === 'start') return null;

  const done = advice === 'done' && last;
  const color = last ? resolveKind(last).color : 'var(--lh-accent)';

  return (
    <section className="mb-5" data-testid="sport-today">
      <h2 className="mb-2 flex items-center justify-between px-1 lh-section">
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
          <span className="block truncate text-xs text-lh-text-secondary">
            {done
              ? [describeWorkout(last), last.minutes > 0 ? formatMinutes(last.minutes, t) : null].filter(Boolean).join(' · ')
              : last
                ? `${relativeDay(last.date, today)} · ${describeWorkout(last)}`
                : ''}
          </span>
        </span>
        {done ? (
          <ChevronRight size={ICON.inline} className="shrink-0 text-lh-text-secondary" />
        ) : (
          <button
            type="button"
            onClick={() => setOpenOn(todayKey())}
            className={`shrink-0 rounded-full bg-lh-accent px-3.5 py-1.5 text-sm font-semibold text-lh-bg active:opacity-80 ${HIT_SLOP_44}`}
          >
            {t('Отметить')}
          </button>
        )}
      </div>
      <WorkoutSheet open={openOn !== null} onClose={() => setOpenOn(null)} workout={null} date={openOn ?? today} last={lastSessionLead(workouts, today)} />
    </section>
  );
}
