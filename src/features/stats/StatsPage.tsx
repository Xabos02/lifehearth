import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLoaded } from '../../hooks/useLoaded';
import { FileText, Share2 } from 'lucide-react';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { Goal, LearningItem, Task } from '../../db/types';
import { addDaysKey, fromKey, todayKey, WEEKDAY_LABELS } from '../../lib/dates';
import { getISODay } from 'date-fns';
import { goalProgress } from '../../lib/progress';
import { financeSummary, formatRub } from '../../lib/finance';
import { buildReport, reportFilename } from '../../lib/report';
import { Screen } from '../../components/layout/Screen';
import { ProgressRing } from '../../components/ui/ProgressRing';
import { ICON } from '../../components/ui/icons';
import { EmptyState } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/toastContext';
import { IconButton } from '../../components/ui/IconButton';
import { EnergyStatsCard } from '../energy/EnergyStatsCard';
import { compactDuration, formatDuration } from '../../lib/duration';
import { t } from '../../lib/i18n';
import { GChevronDown, GStats as ChartColumnBig } from '../../components/ui/glyphs';

interface TaskStats {
  /** последние 7 дней (старые → новые): подпись дня + число выполненных */
  week: { label: string; count: number }[];
}

/** Недельная гистограмма выполненных задач. Производные от текущей даты — здесь. */
function computeTaskStats(tasks: Task[]): TaskStats {
  const today = todayKey();
  // Бакеты по дням последней недели: ключ даты → счётчик выполненных.
  const weekKeys = Array.from({ length: 7 }, (_, i) => addDaysKey(today, -6 + i));
  const weekCount = new Map<string, number>(weekKeys.map((k) => [k, 0]));

  for (const t of tasks) {
    if (!t.completedAt) continue;
    const day = t.completedAt.slice(0, 10);
    if (weekCount.has(day)) weekCount.set(day, (weekCount.get(day) ?? 0) + 1);
  }

  const week = weekKeys.map((k) => ({
    label: WEEKDAY_LABELS[getISODay(fromKey(k)) - 1],
    count: weekCount.get(k) ?? 0,
  }));

  return { week };
}

interface TaskBreakdown {
  total: number; // активных (не удалённых)
  completed: number; // выполнено полностью
  open: number; // не выполнено
  partial: number; // выполнено не полностью (чеклист начат, но не закончен)
  partialOnTime: number; // частично и без просрочки — отрезок полосы статусов
  overdue: number; // просрочено (из невыполненных)
  skipped: number; // суммарно отмечено «пропущена» (исторически, для статистики)
  dueToday: number; // срок — сегодня
  noDate: number; // без срока (из невыполненных)
  deleted: number; // в корзине
  completionRate: number; // % выполнения (выполнено / выполнено+открыто)
  avgChecklist: number; // средний прогресс по всем пунктам чеклистов, %
}

/** Разбор задач по статусам. tasks — живые (без удалённых), deleted — счётчик корзины. */
function computeTaskBreakdown(tasks: Task[], deleted: number): TaskBreakdown {
  const today = todayKey();
  let completed = 0;
  let open = 0;
  let partial = 0;
  let partialOnTime = 0;
  let overdue = 0;
  let dueToday = 0;
  let noDate = 0;
  let checkDone = 0;
  let checkTotal = 0;
  let skipped = 0;

  for (const t of tasks) {
    if (t.frozenAt) continue; // замороженные на паузе — в статистике не учитываем
    const items = t.checklist ?? [];
    const done = items.filter((c) => c.done).length;
    checkTotal += items.length;
    checkDone += done;
    skipped += t.skippedCount ?? 0;

    if (t.completedAt) {
      completed += 1;
      continue;
    }
    open += 1;
    if (t.dueDate !== null && t.dueDate < today) overdue += 1;
    else if (t.dueDate === today) dueToday += 1;
    if (t.dueDate === null) noDate += 1;
    if (items.length > 0 && done > 0 && done < items.length) {
      partial += 1;
      if (!(t.dueDate !== null && t.dueDate < today)) partialOnTime += 1;
    }
  }

  const closed = completed + open;
  return {
    total: tasks.filter((t) => !t.frozenAt).length,
    completed,
    open,
    partial,
    partialOnTime,
    overdue,
    skipped,
    dueToday,
    noDate,
    deleted,
    completionRate: closed === 0 ? 0 : Math.round((completed / closed) * 100),
    avgChecklist: checkTotal === 0 ? 0 : Math.round((checkDone / checkTotal) * 100),
  };
}

interface TaskTimeStats {
  today: number; // суммарная длительность задач на сегодня, мин
  weekTotal: number; // за последние 7 дней, мин
  /** последние 7 дней (старые → новые): подпись дня + суммарные минуты */
  days: { label: string; minutes: number; isToday: boolean }[];
}

/** Запланированное время по задачам с заданной длительностью, сгруппированное
 *  по дню (Task.dueDate). Берём только задачи, у которых задан duration. */
function computeTaskTime(tasks: Task[]): TaskTimeStats {
  const today = todayKey();
  const keys = Array.from({ length: 7 }, (_, i) => addDaysKey(today, -6 + i));
  const perDay = new Map<string, number>(keys.map((k) => [k, 0]));

  for (const t of tasks) {
    if (t.duration == null || t.dueDate == null) continue;
    if (perDay.has(t.dueDate)) perDay.set(t.dueDate, (perDay.get(t.dueDate) ?? 0) + t.duration);
  }

  const days = keys.map((k) => ({
    label: WEEKDAY_LABELS[getISODay(fromKey(k)) - 1],
    minutes: perDay.get(k) ?? 0,
    isToday: k === today,
  }));

  return {
    today: perDay.get(today) ?? 0,
    weekTotal: days.reduce((s, d) => s + d.minutes, 0),
    days,
  };
}

/** Плитка дополнительного показателя в раскрывашке под эффективностью. */
function StatTile({ value, label, color }: { value: ReactNode; label: string; color?: string }) {
  return (
    // min-w-0 обязателен: у grid-элемента min-width:auto — без него колонка
    // распирается по min-content подписи и сетка вылезает за карточку.
    <div className="min-w-0 rounded-[10px] bg-lh-surface-2 px-2.5 py-2.5">
      <p className="text-lg font-light leading-none tabular-nums" style={color ? { color } : undefined}>
        {value}
      </p>
      <p className="mt-1.5 break-words hyphens-auto text-2xs leading-tight text-lh-text-secondary">{label}</p>
    </div>
  );
}

/** Столбики по дням недели. Значение подписано над столбиком: серый столбик
 *  на тёмной карточке сам по себе не держит контраст, число — держит. */
function WeekBars({
  days,
  max,
  format,
}: {
  days: { label: string; value: number; isToday: boolean }[];
  max: number;
  format: (v: number) => string;
}) {
  return (
    <div className="mt-4 flex h-28 items-stretch gap-2.5">
      {days.map((d, i) => (
        <div key={i} className="flex h-full min-w-0 flex-1 flex-col items-center gap-1.5">
          <span className="h-4 text-2xs tabular-nums text-lh-text-secondary">{format(d.value)}</span>
          <div className="flex w-full flex-1 items-end">
            <div
              className={`w-full rounded-[4px] transition-[height] duration-300 ${d.isToday ? 'bg-lh-accent' : 'bg-lh-surface-2'}`}
              style={{ height: `${Math.round((d.value / max) * 100)}%`, minHeight: 4 }}
            />
          </div>
          <span className={`text-2xs ${d.isToday ? 'font-semibold text-lh-accent' : 'text-lh-text-secondary'}`}>
            {t(d.label)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Плитка-ссылка на раздел: подпись, крупное число, пояснение. */
function SectionTile({
  to,
  title,
  value,
  hint,
  valueClass = '',
}: {
  to: string;
  title: string;
  value: ReactNode;
  hint: string;
  valueClass?: string;
}) {
  return (
    <Link to={to} className="card block min-w-0 p-4 active:opacity-70">
      <span className="lh-section block">{title}</span>
      <span className={`mt-2 block text-2xl font-light leading-none tabular-nums ${valueClass}`}>{value}</span>
      <span className="mt-1.5 block text-xs text-lh-text-secondary">{hint}</span>
    </Link>
  );
}

/** Экран статистики/обзора продуктивности. */
export function StatsPage() {
  // Четыре источника, и «пусто» здесь подменяет ВЕСЬ экран. Пока хотя бы один
  // не ответил, показывать «Пока нет данных» нельзя: человек с полным
  // приложением видел бы вспышку пустого экрана при каждом заходе.
  const tasksRaw = useLiveQuery<Task[]>(() => db.tasks.toArray(), []);
  const goalsRaw = useLiveQuery<Goal[]>(() => db.goals.toArray(), []);
  const learningRaw = useLiveQuery<LearningItem[]>(() => db.learningItems.toArray(), []);
  const expensesRaw = useLiveQuery(() => db.expenseItems.toArray(), []);
  // Пятый источник — только ради noData ниже: сам блок энергии берёт данные
  // сам (EnergyStatsCard). Иначе человек, который неделю отмечал энергию и
  // больше ничем не пользовался, открывал бы статистику и видел «нет данных».
  const energyRaw = useLiveQuery(() => db.energyLogs.toArray(), []);
  const loaded = useLoaded(tasksRaw, goalsRaw, learningRaw, expensesRaw, energyRaw);
  const allTasks = tasksRaw ?? [];
  const tasks = alive(allTasks);
  const deletedTasks = allTasks.length - tasks.length;
  const goals = alive(goalsRaw ?? []);
  const learning = alive(learningRaw ?? []);
  const expenses = alive(expensesRaw ?? []);
  const toast = useToast();
  const [moreOpen, setMoreOpen] = useState(false);

  async function handleShareReport() {
    const md = await buildReport();
    const file = new File([md], reportFilename(), { type: 'text/markdown' });

    // share-шит — только на iOS (там это путь в «Файлы»); на десктопе
    // системный share-диалог блокирует страницу, качаем напрямую
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch (err) {
        // AbortError — пользователь закрыл шит шаринга, это не ошибка
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          toast(t('Не удалось поделиться отчётом. Попробуйте ещё раз'));
        }
        return;
      }
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    toast(t('Отчёт готов'));
  }

  const taskStats = useMemo(() => computeTaskStats(tasks), [tasks]);
  const taskBreakdown = useMemo(() => computeTaskBreakdown(tasks, deletedTasks), [tasks, deletedTasks]);
  const taskTime = useMemo(() => computeTaskTime(tasks), [tasks]);

  const tasksByGoal = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      if (!t.goalId) continue;
      const arr = map.get(t.goalId);
      if (arr) arr.push(t);
      else map.set(t.goalId, [t]);
    }
    return map;
  }, [tasks]);

  const activeGoals = useMemo(
    () =>
      goals
        .filter((g) => g.status === 'active')
        .map((g) => {
          const linked = g.progressMode === 'tasks' ? (tasksByGoal.get(g.id) ?? []) : [];
          return { goal: g, value: goalProgress(g, linked) };
        }),
    [goals, tasksByGoal],
  );

  const avgGoalProgress = useMemo(
    () =>
      activeGoals.length === 0
        ? 0
        : Math.round(activeGoals.reduce((s, g) => s + g.value, 0) / activeGoals.length),
    [activeGoals],
  );

  const learningStats = useMemo(
    () => ({
      done: learning.filter((l) => l.status === 'done').length,
      inProgress: learning.filter((l) => l.status === 'inProgress').length,
    }),
    [learning],
  );

  const finance = useMemo(() => financeSummary(expenses), [expenses]);

  const maxWeek = useMemo(
    () => Math.max(1, ...taskStats.week.map((d) => d.count)),
    [taskStats],
  );

  const maxTime = useMemo(() => Math.max(1, ...taskTime.days.map((d) => d.minutes)), [taskTime]);

  const noData =
    tasks.length === 0 &&
    goals.length === 0 &&
    learning.length === 0 &&
    expenses.length === 0 &&
    alive(energyRaw ?? []).length === 0;

  // Пока не ответил хотя бы один источник — только оболочка экрана. Иначе
  // выбор был бы между двумя вспышками: ложное «нет данных» или графики,
  // построенные по нулям.
  if (!loaded) return (
    <Screen title={t('Статистика')} backTo="/home">
      <div />
    </Screen>
  );

  if (noData) {
    return (
      <Screen title={t('Статистика')} backTo="/home">
        <EmptyState
          icon={ChartColumnBig}
          title={t('Пока нет данных')}
          hint={t('Добавьте задачи, цели или другие записи — здесь появится обзор продуктивности')}
        />
      </Screen>
    );
  }

  // Полоса статусов: доли не пересекаются и в сумме дают все активные задачи.
  // Просроченная задача с начатым чек-листом — «просрочено», а не «частично»:
  // срок важнее, и одна задача не должна занимать два отрезка.
  const b = taskBreakdown;
  const segPartial = Math.max(0, b.partialOnTime);
  const segOverdue = b.overdue;
  const segOpen = Math.max(0, b.open - segOverdue - segPartial);
  const segments = [
    { key: 'done', label: t('Выполнено'), value: b.completed, className: 'bg-lh-accent' },
    { key: 'partial', label: t('Частично'), value: segPartial, className: 'bg-[color-mix(in_oklab,var(--lh-accent)_50%,var(--lh-surface))]' },
    { key: 'overdue', label: t('Просрочено'), value: segOverdue, className: 'bg-danger' },
    { key: 'open', label: t('Не выполнено'), value: segOpen, className: 'bg-lh-surface-2 ring-1 ring-inset ring-lh-border-strong' },
  ];
  const segTotal = segments.reduce((s, x) => s + x.value, 0);

  const timeDays = taskTime.days.map((d) => ({ label: d.label, value: d.minutes, isToday: d.isToday }));
  const doneDays = taskStats.week.map((d, i) => ({ label: d.label, value: d.count, isToday: i === 6 }));

  return (
    <Screen
      title={t('Статистика')}
      backTo="/home"
      right={
        <IconButton icon={Share2} label={t('Поделиться отчётом')} onClick={() => void handleShareReport()} />
      }
    >
      <div className="flex flex-col gap-6">
        {/* Эффективность — кольцо, полоса статусов, легенда и раскрывашка */}
        <section className="card p-5" aria-labelledby="stats-eff">
          <div className="flex items-center gap-5">
            <div className="relative">
              <ProgressRing value={b.completionRate} size={104} strokeWidth={7} label="" />
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-3xl font-light tabular-nums">
                {b.completionRate}
                <span className="text-sm text-lh-text-secondary">%</span>
              </span>
            </div>
            <div className="min-w-0">
              <h2 id="stats-eff" className="text-xs font-normal text-lh-text-secondary">
                {t('Эффективность')}
              </h2>
              <p className="mt-0.5 text-lg font-light leading-tight">
                {b.total === 0
                  ? t('Активных задач пока нет')
                  : t('Выполнено {done} из {total}', { done: b.completed, total: b.total })}
              </p>
              {b.dueToday > 0 && (
                <p className="mt-1.5 text-xs text-lh-text-secondary tabular-nums">
                  {t('Срок сегодня: {n}', { n: b.dueToday })}
                </p>
              )}
            </div>
          </div>

          {segTotal > 0 && (
            <div className="mt-5 flex h-2 gap-[2px] overflow-hidden rounded-full" aria-hidden="true">
              {segments
                .filter((x) => x.value > 0)
                .map((x) => (
                  <i key={x.key} className={`h-full ${x.className}`} style={{ width: `${(x.value / segTotal) * 100}%` }} />
                ))}
            </div>
          )}

          <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
            {segments.map((x) => (
              <li key={x.key} className="flex min-w-0 items-center gap-2">
                <i className={`h-2 w-2 shrink-0 rounded-[2px] ${x.className}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{x.label}</span>
                <span className="tabular-nums">{x.value}</span>
              </li>
            ))}
          </ul>

          <button
            type="button"
            aria-expanded={moreOpen}
            aria-controls="stats-more"
            onClick={() => setMoreOpen((v) => !v)}
            className="mt-4 flex min-h-11 w-full items-center justify-between gap-3 border-t border-lh-border pt-3 text-left text-sm text-lh-text-secondary active:opacity-70"
          >
            <span className="min-w-0">
              {moreOpen ? t('Скрыть показатели') : t('Ещё 6 показателей — пропущено, в корзине, чек-листы…')}
            </span>
            <GChevronDown
              size={ICON.inline}
              className={`shrink-0 transition-transform ${moreOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {moreOpen && (
            <div id="stats-more" className="mt-3 grid grid-cols-3 gap-2">
              <StatTile value={b.total} label={t('всего активных')} />
              <StatTile
                value={b.skipped}
                label={t('пропущено')}
                color={b.skipped > 0 ? 'var(--app-warning)' : undefined}
              />
              <StatTile value={b.deleted} label={t('в корзине')} />
              <StatTile value={b.dueToday} label={t('срок сегодня')} />
              <StatTile value={b.noDate} label={t('без срока')} />
              <StatTile value={`${b.avgChecklist}%`} label={t('чек-листы')} />
            </div>
          )}
        </section>

        {/* Энергия — блок берёт данные сам и молчит, пока отметок меньше семи */}
        <EnergyStatsCard />

        {/* Время на задачи — запланированная длительность по дням недели */}
        {taskTime.weekTotal > 0 && (
          <section aria-labelledby="stats-time">
            <h2 id="stats-time" className="mb-2.5 px-1 lh-section">
              {t('Время на задачи')}
            </h2>
            <div className="card p-4">
              <p className="text-3xl font-light leading-none tabular-nums">{formatDuration(taskTime.weekTotal)}</p>
              <p className="mt-1.5 text-xs text-lh-text-secondary">
                {t('за 7 дней · сегодня — {time}', {
                  time: taskTime.today > 0 ? formatDuration(taskTime.today) : t('0м'),
                })}
              </p>
              <WeekBars days={timeDays} max={maxTime} format={compactDuration} />
            </div>
          </section>
        )}

        {/* Выполнено за неделю — сколько задач закрыто по дням */}
        <section aria-labelledby="stats-week">
          <h2 id="stats-week" className="mb-2.5 px-1 lh-section">
            {t('За неделю')}
          </h2>
          <div className="card p-4">
            <p className="text-3xl font-light leading-none tabular-nums">
              {taskStats.week.reduce((s, d) => s + d.count, 0)}
            </p>
            <p className="mt-1.5 text-xs text-lh-text-secondary">{t('задач выполнено за 7 дней')}</p>
            <WeekBars days={doneDays} max={maxWeek} format={(v) => (v > 0 ? String(v) : '')} />
          </div>
        </section>

        {/* Разделы — плитки-ссылки */}
        {(activeGoals.length > 0 || learning.length > 0 || expenses.length > 0) && (
          <section className="grid grid-cols-2 gap-3">
            {activeGoals.length > 0 && (
              <SectionTile
                to="/goals"
                title={t('Цели')}
                value={activeGoals.length}
                hint={t('активных · в среднем {n}%', { n: avgGoalProgress })}
              />
            )}
            {learning.length > 0 && (
              <SectionTile
                to="/more/learning"
                title={t('Развитие')}
                value={learningStats.done}
                hint={t('завершено · {n} в процессе', { n: learningStats.inProgress })}
              />
            )}
            {expenses.length > 0 && (
              <>
                {/* formatRub склеивает разряды NBSP — сумма не переносится,
                    поэтому кегль у сумм ступенью ниже, чем у счётчиков. */}
                <SectionTile
                  to="/more/finance"
                  title={t('Расходы')}
                  value={<span className="text-lg">{formatRub(finance.expense)}</span>}
                  hint={t('в месяц')}
                />
                <SectionTile
                  to="/more/finance"
                  title={t('Баланс')}
                  value={<span className="text-lg">{formatRub(finance.balance)}</span>}
                  valueClass={finance.balance < 0 ? 'text-danger' : 'text-success'}
                  hint={t('доход минус расходы')}
                />
              </>
            )}
          </section>
        )}

        {/* Отчёт — тот же файл, что и кнопка в шапке */}
        <section className="card flex items-center gap-3 p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-lh-surface-2 text-lh-accent">
            <FileText size={ICON.action} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base">{t('Отчёт по всем разделам')}</span>
            <span className="block text-xs text-lh-text-secondary">
              {t('Файл Markdown — для печати или архива')}
            </span>
          </span>
          <button
            type="button"
            onClick={() => void handleShareReport()}
            className="flex h-11 shrink-0 items-center px-1 text-sm font-semibold text-lh-accent active:opacity-60"
          >
            {t('Поделиться')}
          </button>
        </section>
      </div>
    </Screen>
  );
}
