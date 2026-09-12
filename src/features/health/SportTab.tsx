import { useMemo, useRef, type ChangeEvent } from 'react';
import { format } from 'date-fns';
import { ProgressRing } from '../../components/ui/ProgressRing';
import { EmptyState } from '../../components/ui/EmptyState';
import { GChevronRight as ChevronRight, GEnergy as Activity } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { useToast } from '../../components/ui/toastContext';
import { t, tPlural } from '../../lib/i18n';
import { addDaysKey, dateLocale, fromKey, todayKey, weekStartKey } from '../../lib/dates';
import { updateSettings, useSettings } from '../../hooks/useSettings';
import type { Workout } from '../../db/types';
import { DEFAULT_WEEKLY_GOAL, EFFORT_LABELS, workoutKind } from './workouts';
import {
  avgIntervalDays,
  byType,
  formatMinutes,
  lastWorkout,
  todayAdvice,
  totals,
  weekProgress,
  weekStreak,
} from './workoutStats';
import { WorkoutCalendar } from './WorkoutCalendar';
import { parseWorkoutsCsv, withoutDuplicates } from './importWorkouts';
import { importParsed } from './workoutRepo';

interface Props {
  workouts: Workout[];
  selected: string;
  onSelect: (date: string) => void;
  onEdit: (w: Workout) => void;
  onAddFor: (date: string) => void;
}

/** Вкладка «Спорт»: что сегодня по ритму, календарь, сводки, недавние. */
export function SportTab({ workouts, selected, onSelect, onEdit, onAddFor }: Props) {
  const today = todayKey();
  const settings = useSettings();
  const goal = settings.workoutWeeklyGoal ?? DEFAULT_WEEKLY_GOAL;
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const advice = todayAdvice(workouts, today);
  const last = lastWorkout(workouts, today);
  const week = weekProgress(workouts, today, goal);
  const monthFrom = today.slice(0, 8) + '01';
  const month = totals(workouts, monthFrom, today);
  const days30From = addDaysKey(today, -29);
  const kinds = byType(workouts, days30From, today);
  const interval = avgIntervalDays(workouts, addDaysKey(today, -59), today);
  const streak = weekStreak(workouts, today, goal);
  const maxKindMinutes = kinds[0]?.minutes ?? 0;

  const selectedList = useMemo(
    () => workouts.filter((w) => w.date === selected).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [workouts, selected],
  );
  const recent = useMemo(
    () => [...workouts].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0, 8),
    [workouts],
  );

  const adviceTitle = {
    start: t('Первая тренировка — сегодня?'),
    done: t('Сегодня уже была'),
    rest: t('Сегодня — отдых'),
    train: t('Сегодня — тренировка'),
  }[advice];
  const lastLine = last
    ? t('Последняя — {when}, {what}', { when: relativeDay(last.date, today), what: describe(last) })
    : t('Отметьте первую — и календарь начнёт считать ритм.');

  const importCsv = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const parsed = parseWorkoutsCsv(text);
    const fresh = withoutDuplicates(parsed.rows, workouts);
    if (parsed.rows.length === 0) {
      toast(t('В файле не нашлось тренировок: нужны колонки с датой и длительностью.'));
      return;
    }
    const msg = t('Найдено записей: {n}, новых: {fresh}, не разобрано строк: {skipped}. Добавить новые?', {
      n: parsed.rows.length,
      fresh: fresh.length,
      skipped: parsed.skipped,
    });
    if (fresh.length === 0) {
      toast(t('Все записи из файла уже есть.'));
      return;
    }
    if (!window.confirm(msg)) return;
    const n = await importParsed(fresh);
    toast(t('Добавлено: {n} {what}', { n, what: tPlural(n, ['тренировка', 'тренировки', 'тренировок']) }));
  };

  return (
    <div className="space-y-4">
      <section className="card p-4" data-testid="sport-status">
        <div className="flex items-center gap-4">
          <ProgressRing value={(week.done / week.goal) * 100} size={64} strokeWidth={6} label={`${week.done}/${week.goal}`} />
          <div className="min-w-0 flex-1">
            <p className="text-xl font-bold leading-tight tracking-tight">{adviceTitle}</p>
            <p className="mt-1 text-sm leading-snug text-muted">{lastLine}</p>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-hairline pt-3">
          <span className="text-sm text-muted">{t('Цель на неделю')}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={t('Цель: меньше')}
              onClick={() => void updateSettings({ workoutWeeklyGoal: Math.max(1, goal - 1) })}
              className="flex size-9 items-center justify-center rounded-full border border-border text-muted active:scale-90"
            >
              −
            </button>
            <span className="w-8 text-center text-base font-semibold tabular-nums" data-testid="weekly-goal">
              {goal}
            </span>
            <button
              type="button"
              aria-label={t('Цель: больше')}
              onClick={() => void updateSettings({ workoutWeeklyGoal: Math.min(7, goal + 1) })}
              className="flex size-9 items-center justify-center rounded-full border border-border text-muted active:scale-90"
            >
              +
            </button>
          </div>
        </div>
      </section>

      <WorkoutCalendar workouts={workouts} selected={selected} onSelect={onSelect} />

      <section className="card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="px-1 text-sm font-semibold text-muted">
            {selected === today ? t('Сегодня') : format(fromKey(selected), 'd MMMM, EEEE', { locale: dateLocale() })}
          </h2>
          <button
            type="button"
            onClick={() => onAddFor(selected)}
            className={`text-sm font-medium text-accent active:opacity-60 ${HIT_SLOP_44}`}
          >
            {t('+ Тренировка')}
          </button>
        </div>
        {selectedList.length === 0 ? (
          <p className="px-1 text-sm text-muted">{t('Тренировок не отмечено.')}</p>
        ) : (
          selectedList.map((w) => <WorkoutRow key={w.id} w={w} onClick={() => onEdit(w)} />)
        )}
      </section>

      <div className="flex gap-3">
        <Stat value={String(week.done)} label={t('дней на неделе')} />
        <Stat value={String(month.count)} label={t('за месяц')} />
        <Stat value={formatMinutes(month.minutes, t)} label={t('за месяц')} />
      </div>
      <div className="flex gap-3">
        <Stat value={interval === null ? '—' : interval.toFixed(1).replace('.', ',')} label={t('дней между')} />
        <Stat value={String(streak)} label={t('недель по цели')} />
      </div>

      {kinds.length > 0 && (
        <section className="card p-4">
          <h2 className="mb-2 px-1 text-sm font-semibold text-muted">{t('За 30 дней по видам')}</h2>
          {kinds.map((k) => {
            const kind = workoutKind(k.type);
            return (
              <div key={k.type} className="flex items-center gap-3 py-1.5">
                <span className="w-20 shrink-0 truncate text-sm font-medium">{t(kind.label)}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-hairline">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${Math.max(4, (k.minutes / maxKindMinutes) * 100)}%`, background: kind.color }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted">
                  {formatMinutes(k.minutes, t)}
                  {kind.hasDistance && k.distanceKm > 0 ? ` · ${k.distanceKm.toFixed(1).replace('.', ',')} ${t('км')}` : ''}
                </span>
              </div>
            );
          })}
        </section>
      )}

      <section className="card p-4">
        <h2 className="mb-2 px-1 text-sm font-semibold text-muted">{t('Недавние')}</h2>
        {recent.length === 0 ? (
          <EmptyState icon={Activity} title={t('Пока пусто')} hint={t('Нажмите «+», чтобы отметить тренировку.')} />
        ) : (
          recent.map((w) => <WorkoutRow key={w.id} w={w} onClick={() => onEdit(w)} withDate />)
        )}
      </section>

      <section className="card p-4">
        <h2 className="mb-1 px-1 text-sm font-semibold text-muted">{t('Из других приложений')}</h2>
        <p className="px-1 text-xs leading-snug text-muted">
          {t('Apple Health веб-приложению закрыт, а Strava пускает к данным только по платной подписке. Зато файл выгрузки есть у всех: подойдёт activities.csv из Strava, выгрузка Garmin или своя таблица с датой, видом и минутами.')}
        </p>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="mt-3 w-full rounded-xl bg-surface-2 px-4 py-3 text-center font-semibold active:opacity-80"
        >
          {t('Импорт из CSV')}
        </button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void importCsv(e)} data-testid="workout-csv" />
      </section>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex-1 rounded-2xl bg-surface-2 p-3 text-center">
      <p className="text-xl font-bold leading-tight tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted">{label}</p>
    </div>
  );
}

function WorkoutRow({ w, onClick, withDate = false }: { w: Workout; onClick: () => void; withDate?: boolean }) {
  const kind = workoutKind(w.type);
  const effort = EFFORT_LABELS.find((e) => e.value === w.effort)?.label;
  const sub = [
    withDate ? format(fromKey(w.date), 'EEE, d MMMM', { locale: dateLocale() }) : null,
    effort ? t(effort).toLowerCase() : null,
    w.note || null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 border-b border-hairline py-2.5 text-left last:border-b-0 active:opacity-70"
    >
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: kind.color }} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{t(kind.label)}</span>
        {sub && <span className="block truncate text-xs text-muted">{sub}</span>}
      </span>
      <span className="shrink-0 text-right text-sm tabular-nums">
        {formatMinutes(w.minutes, t)}
        {w.distanceKm != null && (
          <span className="block text-xs text-muted">{`${w.distanceKm.toFixed(1).replace('.', ',')} ${t('км')}`}</span>
        )}
      </span>
      <ChevronRight size={ICON.base} className="shrink-0 text-muted" />
    </button>
  );
}

function relativeDay(date: string, today: string): string {
  if (date === today) return t('сегодня');
  if (date === addDaysKey(today, -1)) return t('вчера');
  if (date === addDaysKey(today, -2)) return t('позавчера');
  if (date >= weekStartKey(today)) return format(fromKey(date), 'EEEE', { locale: dateLocale() });
  return format(fromKey(date), 'd MMMM', { locale: dateLocale() });
}

function describe(w: Workout): string {
  const kind = workoutKind(w.type);
  const dist = w.distanceKm != null ? ` ${w.distanceKm.toFixed(1).replace('.', ',')} ${t('км')}` : '';
  return `${t(kind.label).toLowerCase()}${dist}`;
}
