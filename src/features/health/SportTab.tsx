import { useMemo, useRef, type ChangeEvent, type ReactNode } from 'react';
import { format } from 'date-fns';
import { db } from '../../db/db';
import { FileUp, Minus } from 'lucide-react';
import { EmptyState } from '../../components/ui/EmptyState';
import { GChevronRight as ChevronRight, GEnergy as Activity, GPlus as Plus } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { useToast } from '../../components/ui/toastContext';
import { t, tPlural } from '../../lib/i18n';
import { addDaysKey, dateLocale, fromKey, todayKey } from '../../lib/dates';
import { updateSettings, useSettings } from '../../hooks/useSettings';
import type { Workout, WorkoutTemplate } from '../../db/types';
import { DEFAULT_WEEKLY_GOAL, EFFORT_LABELS, PACE_TYPES, resolveKind } from './workouts';
import {
  avgIntervalDays,
  byType,
  formatHours,
  formatMinutes,
  lastWorkout,
  paceMinPerKm,
  sessionCount,
  todayAdvice,
  totals,
  weekProgress,
  weekStreak,
} from './workoutStats';
import { adviceTitle, formatKm, lastLine } from './workoutText';
import { formatExercises } from './exercises';
import { WorkoutCalendar, type Scale } from './WorkoutCalendar';
import { decodeCsv, parseWorkoutsCsv, withoutDuplicates } from './importWorkouts';
import { importParsed } from './workoutRepo';
import { useTemplates } from './templateRepo';
import { confirmAction } from '../../components/ui/confirmStore';

interface Props {
  workouts: Workout[];
  selected: string;
  onSelect: (date: string) => void;
  onEdit: (w: Workout) => void;
  onAddFor: (date: string) => void;
  /** Тренировка по шаблону на выбранный день — чип в карточке дня. */
  onTemplate: (tpl: WorkoutTemplate) => void;
  /** Открыть список шаблонов: выбрать, изменить, завести новый. */
  onTemplates: () => void;
  scale: Scale;
  onScale: (scale: Scale) => void;
}

/** Вкладка «Спорт»: что сегодня по ритму, календарь, сводки, недавние. */
export function SportTab({ workouts, selected, onSelect, onEdit, onAddFor, onTemplate, onTemplates, scale, onScale }: Props) {
  const today = todayKey();
  const settings = useSettings();
  const goal = settings.workoutWeeklyGoal ?? DEFAULT_WEEKLY_GOAL;
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const templates = useTemplates();

  const advice = todayAdvice(workouts, today, goal);
  const last = lastWorkout(workouts, today);
  const week = weekProgress(workouts, today, goal);
  const monthFrom = today.slice(0, 8) + '01';
  const month = totals(workouts, monthFrom, today);
  // Занятия, а не отдельные виды: силовая + растяжка одним занятием — одна
  // тренировка к счётчику, а не две.
  const monthSessions = sessionCount(workouts, monthFrom, today);
  const days30From = addDaysKey(today, -29);
  const kinds = byType(workouts, days30From, today);
  const interval = avgIntervalDays(workouts, addDaysKey(today, -59), today);
  const streak = weekStreak(workouts, today, goal);
  const maxKindMinutes = kinds[0]?.minutes ?? 0;
  // Ни у одного вида нет минут (одни упражнения) — полосы по числу занятий, как подпись.
  const maxKindCount = Math.max(1, ...kinds.map((k) => k.count));

  const selectedList = useMemo(
    () => workouts.filter((w) => w.date === selected).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [workouts, selected],
  );
  // Записи — свежие первыми, а виды одного занятия — в порядке ввода, как в
  // карточке дня: их метки идут подряд по миллисекунде (addWorkoutSession).
  const recent = useMemo(
    () =>
      [...workouts]
        .sort(
          (a, b) =>
            b.date.localeCompare(a.date) ||
            (a.groupId && a.groupId === b.groupId ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)),
        )
        .slice(0, 8),
    [workouts],
  );

  const importCsv = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = decodeCsv(await file.arrayBuffer());
    const parsed = parseWorkoutsCsv(text);
    // Сверка со ВСЕЙ таблицей, включая удалённые: иначе удалённая рукой
    // запись воскресала при следующем импорте той же выгрузки.
    const fresh = withoutDuplicates(parsed.rows, await db.workouts.toArray());
    if (parsed.rows.length === 0) {
      // Колонки есть, но ни одна строка не подошла (дата, которой нет, или
      // позже сегодня) — говорим это, а не «нужны колонки».
      toast(
        parsed.skipped > 0
          ? t('Ни одна строка из {n} не разобрана: проверьте дату и длительность.', { n: parsed.skipped })
          : t('В файле не нашлось тренировок: нужны колонки с датой и длительностью.'),
      );
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
    if (!(await confirmAction({ title: msg, confirmLabel: t('Добавить'), danger: false }))) return;
    const n = await importParsed(fresh);
    toast(t('Добавлено: {n} {what}', { n, what: tPlural(n, ['тренировка', 'тренировки', 'тренировок']) }));
  };

  return (
    <div className="space-y-6">
      <section className="card p-4" data-testid="sport-status">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-lh-text-secondary">{t('Цель на неделю')}</p>
            {/* «1/3» одним текстом: число и цель стоят рядом, e2e читает их
                вместе, а цель отдельно — по data-testid. */}
            <p className="text-2xl font-light leading-tight tabular-nums">
              {week.done}
              <span className="text-lh-text-secondary">/</span>
              <span data-testid="weekly-goal">{goal}</span>
              <span className="ml-1.5 text-base text-lh-text-secondary">
                {tPlural(goal, ['тренировка', 'тренировки', 'тренировок'])}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StepButton label={t('Цель: меньше')} onClick={() => void updateSettings({ workoutWeeklyGoal: Math.max(1, goal - 1) })}>
              <Minus size={ICON.action} />
            </StepButton>
            <StepButton label={t('Цель: больше')} onClick={() => void updateSettings({ workoutWeeklyGoal: Math.min(7, goal + 1) })}>
              <Plus size={ICON.action} />
            </StepButton>
          </div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-lh-surface-2" aria-hidden>
          <div
            className="h-full rounded-full bg-lh-accent transition-[width] duration-300"
            style={{ width: `${Math.min(100, (week.done / Math.max(1, week.goal)) * 100)}%` }}
          />
        </div>
        <div className="mt-4 border-t border-lh-border pt-3">
          <p className="leading-snug">{adviceTitle(advice)}</p>
          <p className="mt-0.5 text-xs leading-snug text-lh-text-secondary">{lastLine(last, today)}</p>
        </div>
      </section>

      <WorkoutCalendar workouts={workouts} selected={selected} onSelect={onSelect} scale={scale} onScale={onScale} />

      <section>
        <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
          <h2 className="lh-section">
            {selected === today ? t('Сегодня') : format(fromKey(selected), 'd MMMM, EEEE', { locale: dateLocale() })}
          </h2>
          <button
            type="button"
            onClick={() => onAddFor(selected)}
            className="-my-3 min-h-11 text-xs text-lh-accent active:opacity-60"
          >
            {t('+ Тренировка')}
          </button>
        </div>
        <div className="card">
        {selectedList.length === 0 ? (
          <p className="px-4 py-3.5 text-sm text-lh-text-secondary">{t('Тренировок не отмечено.')}</p>
        ) : (
          <div className="divide-y divide-lh-border">
            {selectedList.map((w) => <WorkoutRow key={w.id} w={w} onClick={() => onEdit(w)} />)}
          </div>
        )}
        {/* Шаблоны — там же, где день (канва design/sport-templates): чип
            открывает запись на выбранный день уже заполненной. Раньше до них
            было три касания через «Новую тренировку». */}
        {templates && (
        <div className="border-t border-lh-border px-4 pb-3 pt-1" data-testid="day-templates">
          <div className="flex min-h-11 items-center justify-between">
            <span className="text-sm text-lh-text-secondary">{templates.length > 0 ? t('По шаблону') : t('Шаблонов пока нет.')}</span>
            <button type="button" onClick={onTemplates} className="flex min-h-11 items-center gap-0.5 text-sm font-medium text-lh-accent active:opacity-60">
              {t('Шаблоны')}
              <ChevronRight size={ICON.inline} />
            </button>
          </div>
          {templates.length > 0 && (
            <div className="flex flex-wrap gap-2 pb-1">
              {templates.map((tpl) => (
                // Высота 44 самой кнопкой, а не невидимой зоной: зону обрезал
                // бы overflow, которым длинное название режется многоточием.
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => onTemplate(tpl)}
                  aria-label={t('По шаблону: {name}', { name: tpl.name })}
                  className="flex min-h-11 max-w-full items-center rounded-full border border-lh-border-strong bg-lh-surface-2 px-3.5 text-sm font-medium text-lh-text-primary active:scale-95"
                >
                  <span className="truncate">{tpl.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        )}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <Stat value={String(monthSessions)} label={t('тренировок за месяц')} />
        <Stat value={formatHours(month.minutes, t)} label={t('часов за месяц')} />
        <Stat value={interval === null ? '—' : interval.toFixed(1).replace('.', ',')} label={t('дней между тренировками')} />
        <Stat value={String(streak)} label={t('недель подряд с целью')} accent={streak > 0} />
      </section>

      {kinds.length > 0 && (
        <section>
          <h2 className="mb-2.5 px-1 lh-section">{t('За 30 дней по видам')}</h2>
          <div className="card space-y-3.5 p-4">
            {kinds.map((k) => {
              const kind = resolveKind(k);
              const amount =
                kind.hasDistance && k.distanceKm > 0
                  ? formatKm(k.distanceKm)
                  : k.minutes > 0
                    ? formatMinutes(k.minutes, t)
                    : null;
              return (
                <div key={`${k.type}-${k.customLabel ?? ''}`}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">{k.type === 'custom' ? kind.label : t(kind.label)}</span>
                    <span className="shrink-0 tabular-nums text-lh-text-secondary">
                      {amount ?? `${k.count} ${tPlural(k.count, ['раз', 'раза', 'раз'])}`}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-lh-surface-2">
                    <div
                      className="h-full rounded-full bg-lh-accent"
                      style={{
                        width: `${Math.max(4, maxKindMinutes > 0 ? (k.minutes / maxKindMinutes) * 100 : (k.count / maxKindCount) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2.5 px-1 lh-section">{t('Недавние')}</h2>
        {recent.length === 0 ? (
          <div className="card">
            <EmptyState icon={Activity} title={t('Пока пусто')} hint={t('Нажмите «+», чтобы отметить тренировку.')} />
          </div>
        ) : (
          <div className="card divide-y divide-lh-border">
            {recent.map((w) => <WorkoutRow key={w.id} w={w} onClick={() => onEdit(w)} withDate />)}
          </div>
        )}
      </section>

      <section className="card">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex w-full items-center gap-3 px-4 py-3.5 text-left active:opacity-80"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 text-lh-text-secondary">
            <FileUp size={ICON.base} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block">{t('Из других приложений')}</span>
            <span className="block text-xs text-lh-text-secondary">{t('Импорт из CSV — Strava, Garmin или своя таблица')}</span>
          </span>
          <ChevronRight size={ICON.base} className="shrink-0 text-lh-text-secondary" />
        </button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void importCsv(e)} data-testid="workout-csv" />
      </section>
    </div>
  );
}

function StepButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-11 items-center justify-center rounded-full border border-lh-border-strong text-lh-text-secondary active:scale-95"
    >
      {children}
    </button>
  );
}

function Stat({ value, label, accent = false }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="card min-w-0 p-4">
      <p className={`text-2xl font-light leading-none tabular-nums ${accent ? 'text-lh-accent' : ''}`}>{value}</p>
      <p className="mt-2 text-xs leading-snug text-lh-text-secondary">{label}</p>
    </div>
  );
}

function WorkoutRow({ w, onClick, withDate = false }: { w: Workout; onClick: () => void; withDate?: boolean }) {
  const kind = resolveKind(w);
  const effort = EFFORT_LABELS.find((e) => e.value === w.effort)?.label;
  // Темп для бега и ходьбы: прогресс на 3–5 км — это темп, а не минуты.
  const pace = PACE_TYPES.has(w.type) ? paceMinPerKm(w.minutes, w.distanceKm) : null;
  const sub = [
    // EEEEEE — «вс», а не «вск»: у date-fns/ru трёхбуквенные «вск, птн, срд» —
    // формы, которых в русской традиции нет.
    withDate ? format(fromKey(w.date), 'EEEEEE, d MMMM', { locale: dateLocale() }) : null,
    pace ? `${pace} /${t('км')}` : null,
    formatExercises(w.exercises) || null,
    effort ? t(effort).toLowerCase() : null,
    w.note || null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3 text-left active:opacity-70"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2" aria-hidden>
        <span className="size-2.5 rounded-full" style={{ background: kind.color }} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{w.type === 'custom' ? kind.label : t(kind.label)}</span>
        {sub && <span className="block truncate text-xs text-lh-text-secondary">{sub}</span>}
      </span>
      <span className="shrink-0 text-right text-sm tabular-nums">
        {w.minutes > 0 && formatMinutes(w.minutes, t)}
        {w.distanceKm != null && <span className="block text-xs text-lh-text-secondary">{formatKm(w.distanceKm)}</span>}
      </span>
      <ChevronRight size={ICON.base} className="shrink-0 text-lh-text-secondary" />
    </button>
  );
}
