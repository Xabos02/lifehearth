import { useState, type ChangeEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { differenceInCalendarDays } from 'date-fns';
import {
  Book,
  Flag,
  FileText,
  Link2,
  Workflow,
  FlaskConical,
  Languages,
  Minus,
  Video,
  type LucideIcon,
} from 'lucide-react';
import {
  GPlus as Plus,
  GClose as X,
  GLearning as GraduationCap,
  GCalendar as CalendarIcon,
  GChevronDown as ChevronDown,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { alive, update } from '../../db/repo';
import type { Goal, LearningItem, LearningKind, Task } from '../../db/types';
import { formatRu, fromKey, todayKey } from '../../lib/dates';
import { formatNum } from '../../lib/finance';
import { t, tPlur } from '../../lib/i18n';
import { goalProgress, goalProgressLabel } from '../../lib/progress';
import { Screen } from '../../components/layout/Screen';
import { Input } from '../../components/ui/Input';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { ProgressRing } from '../../components/ui/ProgressRing';
import { Sheet } from '../../components/ui/Sheet';
import { TaskItem } from '../tasks/TaskItem';
import { TaskEditSheet } from '../tasks/TaskEditSheet';
import { GoalEditSheet } from './GoalEditSheet';
import { ICON } from '../../components/ui/icons';
import { Haptic } from '../../components/ui/Haptic';

const KIND_ICONS: Record<LearningKind, LucideIcon> = {
  book: Book,
  course: GraduationCap,
  article: FileText,
  video: Video,
  research: FlaskConical,
  language: Languages,
};

/** Заголовок секции с кнопкой действия справа. */
function SectionHeader({
  title,
  actionLabel,
  actionIcon: ActionIcon,
  onAction,
}: {
  title: string;
  actionLabel?: string;
  actionIcon?: LucideIcon;
  onAction?: () => void;
}) {
  return (
    <div className="mb-1 flex min-h-11 items-center justify-between px-1">
      <h2 className="lh-section">{title}</h2>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="flex h-11 items-center gap-1.5 text-sm text-lh-accent active:opacity-60"
        >
          {ActionIcon && <ActionIcon size={ICON.inline} />}
          {actionLabel}
        </button>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<Goal['status'], string> = {
  active: 'Активна',
  // Статус, а не команда: «Пауза» и «Архив» в словаре — кнопка плеера
  // и вид файла (Pause / Archive).
  paused: 'На паузе',
  completed: 'Завершена',
  archived: 'В архиве',
};

/** Детальная страница цели: прогресс, связанные задачи, привычки, обучение. */
export function GoalDetailPage() {
  const { id } = useParams<{ id: string }>();

  // undefined — ещё грузится, null — записи нет.
  const goal = useLiveQuery(
    async () => (id ? ((await db.goals.get(id)) ?? null) : null),
    [id],
  );

  const goalTasks =
    useLiveQuery(
      () =>
        id ? db.tasks.where('goalId').equals(id).toArray().then(alive) : Promise.resolve<Task[]>([]),
      [id],
    ) ?? [];
  const allLearning = useLiveQuery(() => db.learningItems.toArray().then(alive), []) ?? [];
  const projects = useLiveQuery(() => db.projects.toArray().then(alive), []) ?? [];

  const [editOpen, setEditOpen] = useState(false);
  const [taskSheetOpen, setTaskSheetOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [linkLearningOpen, setLinkLearningOpen] = useState(false);
  // Черновик ввода числового прогресса строкой (null = поле не редактируется).
  const [valueDraft, setValueDraft] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  if (goal === undefined) {
    return <Screen title={t('Цель')} backTo="/goals">{null}</Screen>;
  }

  if (goal === null || goal.deletedAt) {
    return (
      <Screen title={t('Цель')} backTo="/goals">
        <div className="py-14 text-center">
          <p className="font-semibold text-lh-text-secondary">{t('Цель не найдена')}</p>
          <Link to="/goals" className="mt-2 inline-block text-sm font-medium text-lh-accent">
            {t('К списку целей')}
          </Link>
        </div>
      </Screen>
    );
  }

  const progress = goalProgress(goal, goalTasks);
  const linkedLearning = allLearning.filter((li) => li.goalId === goal.id);
  const availableLearning = allLearning.filter((li) => li.goalId !== goal.id);
  const sortedTasks = [...goalTasks].sort(
    (a, b) => (a.completedAt ? 1 : 0) - (b.completedAt ? 1 : 0) || a.sortOrder - b.sortOrder,
  );
  const current = goal.currentValue ?? 0;

  async function setCurrentValue(value: number) {
    if (!goal || !Number.isFinite(value)) return;
    await update(db.goals, goal.id, { currentValue: Math.max(0, value) });
  }

  // Δ через атомарный modify: читает актуальное значение из БД, поэтому
  // быстрые повторные клики +/- не теряют инкременты (без устаревших замыканий).
  async function changeBy(delta: number) {
    if (!goal) return;
    const id = goal.id;
    await db.goals.where('id').equals(id).modify((g) => {
      g.currentValue = Math.max(0, (g.currentValue ?? 0) + delta);
      g.updatedAt = new Date().toISOString();
    });
  }

  const openTasks = sortedTasks.filter((task) => !task.completedAt);
  const doneTasks = sortedTasks.filter((task) => task.completedAt);
  const daysLeft = goal.targetDate ? differenceInCalendarDays(fromKey(goal.targetDate), fromKey(todayKey())) : null;
  const dueHint =
    daysLeft === null
      ? ''
      : daysLeft < 0
        ? t('срок прошёл')
        : daysLeft === 0
          ? t('сегодня')
          : daysLeft < 14
            ? t('через {x}', { x: tPlur(daysLeft, ['день', 'дня', 'дней']) })
            : t('через {x}', { x: tPlur(Math.round(daysLeft / 7), ['неделю', 'недели', 'недель']) });
  const openTask = (task: Task) => {
    setEditingTask(task);
    setTaskSheetOpen(true);
  };

  return (
    <Screen
      title=""
      backTo="/goals"
      right={
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          className="flex h-11 items-center px-1 text-base font-medium text-lh-accent active:opacity-60"
        >
          {t('Изменить')}
        </button>
      }
    >
      <div className="flex flex-col gap-6">
      <section className="flex flex-col items-center pt-1 text-center">
        <div className="relative">
          <ProgressRing value={progress} size={168} strokeWidth={7} color={goal.color} label="" />
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-5xl font-extralight tabular-nums">
              {Math.round(progress)}
              <span className="text-lg text-lh-text-secondary">%</span>
            </span>
            {goal.progressMode !== 'manual' && (
              <span className="mt-1.5 max-w-[130px] truncate text-xs tabular-nums text-lh-text-secondary">
                {goalProgressLabel(goal, goalTasks)}
              </span>
            )}
          </div>
        </div>
        <span className="mt-5 inline-flex items-center gap-2 text-xs text-lh-text-secondary">
          <span className="size-2 rounded-full" style={{ background: goal.color }} />
          {t(STATUS_LABEL[goal.status])}
        </span>
        <h1 className="mt-2 break-words px-4 text-2xl font-light leading-tight tracking-tight">{goal.title}</h1>
        {goal.targetDate && (
          <p className="mt-2 flex items-center gap-1.5 text-sm tabular-nums text-lh-text-secondary">
            <CalendarIcon size={ICON.inline} className="shrink-0" />
            {t('Срок: {date}', { date: formatRu(goal.targetDate, 'd MMMM yyyy') })}
            {dueHint && ` · ${dueHint}`}
          </p>
        )}
      </section>

      {(goal.description || goal.progressMode === 'tasks') && (
        <section className="card p-4">
          {goal.description && <p className="whitespace-pre-wrap text-sm leading-relaxed">{goal.description}</p>}
          {goal.progressMode === 'tasks' && (
            <p
              className={`flex items-center gap-2 text-xs text-lh-text-secondary ${
                goal.description ? 'mt-4 border-t border-lh-border pt-3' : ''
              }`}
            >
              <Workflow size={ICON.inline} className="shrink-0" />
              {t('Прогресс считается по задачам ниже.')}
            </p>
          )}
        </section>
      )}

      {goal.progressMode === 'manual' && (
        <div className="card p-4">
          <p className="mb-2 text-sm font-medium text-lh-text-secondary">
            {t('Прогресс вручную · {n}%', { n: goal.progressManual })}
          </p>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={goal.progressManual}
            aria-label={t('Прогресс вручную, проценты')}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              update(db.goals, goal.id, { progressManual: Number(e.target.value) })
            }
            className="w-full"
            style={{ accentColor: goal.color }}
          />
        </div>
      )}
      {goal.progressMode === 'numeric' && (
        <div className="card p-4">
          <p className="mb-2 text-sm font-medium text-lh-text-secondary">
            {t('{done} из {total}', {
              done: formatNum(current),
              total: formatNum(goal.targetValue ?? 0),
            })}
            {goal.unitLabel ? ` ${goal.unitLabel}` : ''}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={t('Уменьшить прогресс')}
              onClick={() => {
                setValueDraft(null);
                void changeBy(-1);
              }}
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-lh-surface-2 active:opacity-70"
            >
              <Minus size={ICON.base} />
              {/* Шаг прогресса щёлкает (PROTOCOL §6.4); на нуле тап ничего
                  не меняет, и накладка его пропускает. */}
              <Haptic off={current <= 0} />
            </button>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              value={valueDraft ?? String(current)}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setValueDraft(e.target.value)}
              onBlur={() => {
                if (valueDraft === null) return;
                const n = Number(valueDraft);
                if (valueDraft.trim() !== '' && Number.isFinite(n)) void setCurrentValue(n);
                setValueDraft(null);
              }}
              className="text-center"
            />
            <button
              type="button"
              aria-label={t('Увеличить прогресс')}
              onClick={() => {
                setValueDraft(null);
                void changeBy(1);
              }}
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-lh-surface-2 active:opacity-70"
            >
              <Plus size={ICON.base} />
              <Haptic />
            </button>
          </div>
        </div>
      )}

      <section>
        <SectionHeader
          title={
            openTasks.length > 0
              ? t('Задачи · {x}', { x: tPlur(openTasks.length, ['открытая', 'открытых', 'открытых']) })
              : t('Задачи')
          }
          actionLabel={t('Задача')}
          actionIcon={Plus}
          onAction={() => {
            setEditingTask(null);
            setTaskSheetOpen(true);
          }}
        />
        {sortedTasks.length === 0 && (
          <p className="px-1 text-sm text-lh-text-secondary">{t('Нет привязанных задач.')}</p>
        )}
        <div className="flex flex-col gap-2">
          {openTasks.map((taskItem) => (
            <TaskItem
              key={taskItem.id}
              task={taskItem}
              project={projects.find((p) => p.id === taskItem.projectId) ?? null}
              onEdit={openTask}
            />
          ))}
        </div>
        {doneTasks.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              aria-expanded={showDone}
              className="card mt-2 flex h-12 w-full items-center justify-between px-4 text-sm text-lh-text-secondary active:opacity-70"
            >
              <span>{t('Выполненные · {n}', { n: doneTasks.length })}</span>
              <ChevronDown size={ICON.inline} className={`transition-transform ${showDone ? 'rotate-180' : ''}`} />
            </button>
            {showDone && (
              <div className="mt-2 flex flex-col gap-2">
                {doneTasks.map((taskItem) => (
                  <TaskItem
                    key={taskItem.id}
                    task={taskItem}
                    project={projects.find((p) => p.id === taskItem.projectId) ?? null}
                    onEdit={openTask}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section>
        <SectionHeader
          title={t('Обучение')}
          actionLabel={t('Привязать')}
          actionIcon={Link2}
          onAction={() => setLinkLearningOpen(true)}
        />
        {linkedLearning.length === 0 ? (
          <p className="px-1 text-sm text-lh-text-secondary">{t('Нет привязанных материалов.')}</p>
        ) : (
          <div className="card divide-y divide-lh-border">
            {linkedLearning.map((li: LearningItem) => {
              const Icon = KIND_ICONS[li.kind];
              return (
                <div key={li.id} className="flex items-center gap-3 py-3.5 pl-4 pr-2">
                  <Link
                    to={`/more/learning/${li.id}`}
                    className="flex min-w-0 flex-1 items-center gap-3 active:opacity-70"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 text-lh-accent">
                      <Icon size={ICON.header} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{li.title}</span>
                      <span className="mt-1.5 block">
                        <ProgressBar
                          value={li.progressTarget > 0 ? (li.progressCurrent / li.progressTarget) * 100 : 0}
                          color={goal.color}
                        />
                      </span>
                      {li.progressTarget > 0 && (
                        <span className="mt-1.5 block text-xs tabular-nums text-lh-text-secondary">
                          {t('{done} из {total}', { done: formatNum(li.progressCurrent), total: formatNum(li.progressTarget) })}
                        </span>
                      )}
                    </span>
                  </Link>
                  <button
                    type="button"
                    aria-label={t('Отвязать')}
                    onClick={() => update(db.learningItems, li.id, { goalId: null })}
                    className="flex size-11 shrink-0 items-center justify-center text-lh-text-secondary active:opacity-60"
                  >
                    <X size={ICON.action} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {goal.status === 'active' && (
        <button
          type="button"
          onClick={() => update(db.goals, goal.id, { status: 'completed' })}
          className="card flex min-h-14 w-full items-center justify-center gap-2 px-4 py-3 text-sm text-success active:opacity-70"
        >
          <Flag size={ICON.action} className="shrink-0" />
          <span>
            {t('Цель достигнута?')} {t('Отметить завершённой')}
          </span>
        </button>
      )}
      </div>

      <GoalEditSheet open={editOpen} onClose={() => setEditOpen(false)} goal={goal} />

      <TaskEditSheet
        open={taskSheetOpen}
        onClose={() => {
          setTaskSheetOpen(false);
          setEditingTask(null);
        }}
        task={editingTask}
        defaults={{ goalId: goal.id }}
      />

      <Sheet
        open={linkLearningOpen}
        onClose={() => setLinkLearningOpen(false)}
        title={t('Привязать материал')}
      >
        {availableLearning.length === 0 ? (
          <p className="py-6 text-center text-sm text-lh-text-secondary">{t('Нет материалов для привязки.')}</p>
        ) : (
          <div className="flex flex-col gap-2 pb-2">
            {availableLearning.map((li) => {
              const Icon = KIND_ICONS[li.kind];
              return (
                <button
                  key={li.id}
                  type="button"
                  onClick={async () => {
                    await update(db.learningItems, li.id, { goalId: goal.id });
                    setLinkLearningOpen(false);
                  }}
                  className="flex items-center gap-3 rounded-xl bg-lh-surface-2 px-3.5 py-3 text-left active:opacity-70"
                >
                  <Icon size={ICON.base} className="shrink-0 text-lh-text-secondary" />
                  <span className="min-w-0 flex-1 truncate font-medium">{li.title}</span>
                </button>
              );
            })}
          </div>
        )}
      </Sheet>
    </Screen>
  );
}
