import { useMemo, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLoaded } from '../../hooks/useLoaded';
import {
  Share2,
} from 'lucide-react';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { Goal, LearningItem, Task } from '../../db/types';
import { addDaysKey, fromKey, todayKey, WEEKDAY_LABELS } from '../../lib/dates';
import { getISODay } from 'date-fns';
import { goalProgress, goalProgressLabel } from '../../lib/progress';
import { financeSummary, formatRub } from '../../lib/finance';
import { buildReport, reportFilename } from '../../lib/report';
import { Screen } from '../../components/layout/Screen';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { EmptyState } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/toastContext';
import { IconButton } from '../../components/ui/IconButton';
import { StatCard } from '../../components/ui/StatCard';
import { EnergyStatsCard } from '../energy/EnergyStatsCard';
import { compactDuration, formatDuration } from '../../lib/duration';
import { t } from '../../lib/i18n';
import {
  GStats as ChartColumnBig,
} from '../../components/ui/glyphs';

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
    if (items.length > 0 && done > 0 && done < items.length) partial += 1;
  }

  const closed = completed + open;
  return {
    total: tasks.filter((t) => !t.frozenAt).length,
    completed,
    open,
    partial,
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

function StatNumber({ value, label, color }: { value: number; label: string; color?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-lg font-bold leading-tight" style={color ? { color } : undefined}>
        {value}
      </p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

/** Метрика-плитка: число в собственном фоне с бордером — чтобы пункты в плотной
 *  сетке не сливались в стену цифр. */
function StatTile({ value, label, color }: { value: ReactNode; label: string; color?: string }) {
  return (
    // min-w-0 обязателен: у grid-элемента, как и у flex, min-width:auto — без него
    // колонка распирается по min-content подписи и вся сетка вылезает за карточку.
    <div className="min-w-0 rounded-xl border border-hairline bg-surface-2 px-2.5 py-2.5">
      <p
        className="text-lg font-bold leading-none"
        style={color ? { color } : undefined}
      >
        {value}
      </p>
      {/* На 320px под подпись остаётся ~55px: без переноса и уменьшения «всего
          активных» наезжает на рамку. clamp тянет 11px → 9px к узким экранам. */}
      <p className="mt-1.5 break-words hyphens-auto text-2xs leading-tight text-muted">
        {label}
      </p>
    </div>
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
          return { goal: g, value: goalProgress(g, linked), label: goalProgressLabel(g, linked) };
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

  const topGoals = useMemo(
    () => [...activeGoals].sort((a, b) => b.value - a.value).slice(0, 3),
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

  return (
    <Screen
      title={t('Статистика')}
      backTo="/home"
      right={
        <IconButton icon={Share2} label={t('Поделиться отчётом')} onClick={() => void handleShareReport()} />
      }
    >
      <div className="flex flex-col gap-4">
        {/* Эффективность — разбор задач по статусам */}
        <StatCard title={t('Эффективность')}>
          {/* Хедлайн: процент выполнения + полоса */}
          <div className="mb-3 rounded-xl border border-hairline bg-surface-2 px-3.5 py-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-base font-medium">{t('Выполнено из всех')}</span>
              <span className="shrink-0 text-lg font-bold" style={{ color: 'var(--app-success)' }}>
                {taskBreakdown.completionRate}%
              </span>
            </div>
            <ProgressBar value={taskBreakdown.completionRate} color="var(--app-success)" />
          </div>

          {/* Каждая метрика — отдельная плитка, чтобы пункты не сливались */}
          <div className="grid grid-cols-3 gap-2">
            <StatTile value={taskBreakdown.total} label={t('всего активных')} />
            <StatTile value={taskBreakdown.completed} label={t('выполнено')} color="var(--app-success)" />
            <StatTile value={taskBreakdown.open} label={t('не выполнено')} />
            <StatTile
              value={taskBreakdown.partial}
              label={t('частично')}
              color={taskBreakdown.partial > 0 ? 'var(--app-warning)' : undefined}
            />
            <StatTile
              value={taskBreakdown.overdue}
              label={t('просрочено')}
              color={taskBreakdown.overdue > 0 ? 'var(--app-danger)' : undefined}
            />
            <StatTile
              value={taskBreakdown.skipped}
              label={t('пропущено')}
              color={taskBreakdown.skipped > 0 ? 'var(--app-warning)' : undefined}
            />
            <StatTile value={taskBreakdown.deleted} label={t('в корзине')} />
            <StatTile value={taskBreakdown.dueToday} label={t('срок сегодня')} />
            <StatTile value={taskBreakdown.noDate} label={t('без срока')} />
            <StatTile value={`${taskBreakdown.avgChecklist}%`} label={t('чек-листы')} />
          </div>
        </StatCard>

        {/* Энергия — блок берёт данные сам и молчит, пока отметок меньше семи */}
        <EnergyStatsCard />

        {/* Время на задачи — суммарная длительность задач по дням */}
        {taskTime.weekTotal > 0 && (
          <StatCard title={t('Время на задачи')}>
            <div className="mb-3 rounded-xl border border-hairline bg-surface-2 px-3.5 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-base font-medium">{t('Сегодня на задачи')}</span>
                <span className="shrink-0 text-lg font-bold" style={{ color: 'var(--app-accent-2)' }}>
                  {taskTime.today > 0 ? formatDuration(taskTime.today) : t('0м')}
                </span>
              </div>
            </div>

            <div className="flex items-end justify-between gap-2" style={{ height: 96 }}>
              {taskTime.days.map((d, i) => (
                <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                  <span className="text-2xs font-semibold text-muted">{compactDuration(d.minutes)}</span>
                  <div className="flex w-full flex-1 items-end">
                    <div
                      className="w-full rounded-t-md transition-[height] duration-300"
                      style={{
                        height: `${Math.round((d.minutes / maxTime) * 100)}%`,
                        minHeight: d.minutes > 0 ? 4 : 2,
                        background: 'var(--app-accent-2)',
                        opacity: d.minutes > 0 ? 1 : 0.25,
                      }}
                    />
                  </div>
                  <span className={`text-xs ${d.isToday ? 'font-bold text-text' : 'text-muted'}`}>{t(d.label)}</span>
                </div>
              ))}
            </div>

            <p className="mt-3 text-center text-xs text-muted">
              {t('За неделю всего:')} <span className="font-semibold text-text">{formatDuration(taskTime.weekTotal)}</span>
            </p>
          </StatCard>
        )}

        {/* За неделю — гистограмма выполненных задач по дням */}
        <StatCard title={t('За неделю')}>
          <div className="flex items-end justify-between gap-2" style={{ height: 96 }}>
            {taskStats.week.map((d, i) => (
              <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                <span className="text-xs font-semibold text-muted">{d.count > 0 ? d.count : ''}</span>
                <div className="flex w-full flex-1 items-end">
                  <div
                    className="w-full rounded-t-md bg-accent transition-[height] duration-300"
                    style={{
                      height: `${Math.round((d.count / maxWeek) * 100)}%`,
                      minHeight: d.count > 0 ? 4 : 2,
                      opacity: d.count > 0 ? 1 : 0.25,
                    }}
                  />
                </div>
                <span className="text-xs text-muted">{t(d.label)}</span>
              </div>
            ))}
          </div>
        </StatCard>

        {/* Цели */}
        {activeGoals.length > 0 && (
          <StatCard title={t('Цели')}>
            <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-4">
              <StatNumber value={activeGoals.length} label={t('активных')} />
              <div className="min-w-0">
                <p className="text-lg font-bold leading-tight">{avgGoalProgress}%</p>
                <p className="text-xs text-muted">{t('средний прогресс')}</p>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              {topGoals.map(({ goal, value, label }) => (
                <div key={goal.id}>
                  <div className="mb-1 flex items-baseline justify-between gap-3">
                    <span className="truncate text-base font-medium">{goal.title}</span>
                    <span className="shrink-0 text-xs text-muted">{label}</span>
                  </div>
                  <ProgressBar value={value} color={goal.color} />
                </div>
              ))}
            </div>
          </StatCard>
        )}

        {/* Развитие */}
        {learning.length > 0 && (
          <StatCard title={t('Развитие')}>
            <p className="mb-3 text-sm text-muted">
              {t('Обучение:')}{' '}
              <span className="font-semibold text-text">{learningStats.done} {t('завершено')}</span>
              {' / '}
              <span className="font-semibold text-text">
                {learningStats.inProgress} {t('в процессе')}
              </span>
            </p>
          </StatCard>
        )}

        {/* Финансы */}
        {expenses.length > 0 && (
          <StatCard title={t('Финансы')}>
            {/* formatRub склеивает разряды NBSP — сумма физически не переносится,
                значит помещать её можно только уменьшением кегля. clamp по vw
                делает это плавно и сохраняет две колонки (ломать сетку в одну
                на узких пришлось бы ради одного крайнего случая). */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-4">
              <div className="min-w-0">
                <p className="text-lg font-bold leading-tight tabular-nums">
                  {formatRub(finance.expense)}
                </p>
                <p className="text-xs text-muted">{t('расходы в месяц')}</p>
              </div>
              <div className="min-w-0">
                <p
                  className="text-lg font-bold leading-tight tabular-nums"
                  style={{
                    color:
                      finance.balance < 0 ? 'var(--app-danger)' : 'var(--app-success)',
                  }}
                >
                  {formatRub(finance.balance)}
                </p>
                <p className="text-xs text-muted">{t('баланс')}</p>
              </div>
            </div>
          </StatCard>
        )}
      </div>
    </Screen>
  );
}
