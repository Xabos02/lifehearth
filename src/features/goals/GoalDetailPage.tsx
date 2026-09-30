import { useState, type ChangeEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Book,
  FileText,
  FlaskConical,
  Languages,
  Minus,
  Video,
  type LucideIcon,
} from 'lucide-react';
import {
  GPencil as Pencil,
  GPlus as Plus,
  GClose as X,
  GLearning as GraduationCap,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { alive, update } from '../../db/repo';
import type { LearningItem, LearningKind, Task } from '../../db/types';
import { formatRu } from '../../lib/dates';
import { formatNum } from '../../lib/finance';
import { t } from '../../lib/i18n';
import { goalProgress, goalProgressLabel } from '../../lib/progress';
import { Screen } from '../../components/layout/Screen';
import { Input } from '../../components/ui/Input';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { ProgressRing } from '../../components/ui/ProgressRing';
import { Sheet } from '../../components/ui/Sheet';
import { TaskItem } from '../tasks/TaskItem';
import { TaskEditSheet } from '../tasks/TaskEditSheet';
import { GoalEditSheet } from './GoalEditSheet';
import { IconButton } from '../../components/ui/IconButton';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { ICON } from '../../components/ui/icons';

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
  onAction,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="font-bold">{title}</h2>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction} className="text-sm font-medium text-lh-accent">
          {actionLabel}
        </button>
      )}
    </div>
  );
}

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

  return (
    <Screen
      title={goal.title}
      backTo="/goals"
      right={
        <IconButton icon={Pencil} label={t('Редактировать')} onClick={() => setEditOpen(true)} />
      }
    >
      {goal.description && (
        <p className="mb-4 whitespace-pre-wrap text-sm text-lh-text-secondary">{goal.description}</p>
      )}

      <div className="flex items-center gap-4 card p-4">
        <ProgressRing value={progress} size={96} strokeWidth={7} color={goal.color} />
        <div className="min-w-0">
          <p className="text-lg font-light">{goalProgressLabel(goal, goalTasks)}</p>
          {goal.targetDate && (
            <p className="text-sm text-lh-text-secondary">
              {t('Срок: {date}', { date: formatRu(goal.targetDate, 'd MMMM yyyy') })}
            </p>
          )}
        </div>
      </div>

      {goal.status === 'active' && progress >= 100 && (
        <div className="mt-3 rounded-2xl border border-success/40 bg-success/10 p-4">
          <p className="font-semibold text-success">{t('Цель достигнута?')}</p>
          <button
            type="button"
            onClick={() => update(db.goals, goal.id, { status: 'completed' })}
            className="mt-1 text-sm font-medium text-success underline"
          >
            {t('Отметить завершённой')}
          </button>
        </div>
      )}

      <div className="mt-3">
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
                className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 active:opacity-70"
              >
                <Minus size={ICON.base} />
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
                className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 active:opacity-70"
              >
                <Plus size={ICON.base} />
              </button>
            </div>
          </div>
        )}
        {goal.progressMode === 'tasks' && (
          <p className="px-1 text-sm text-lh-text-secondary">{t('Прогресс считается по задачам ниже.')}</p>
        )}
      </div>

      <section className="mt-6">
        <SectionHeader title={t('Задачи')} />
        {sortedTasks.length === 0 && (
          <p className="px-1 text-sm text-lh-text-secondary">{t('Нет привязанных задач.')}</p>
        )}
        <div className="flex flex-col gap-2">
          {sortedTasks.map((taskItem) => (
            <TaskItem
              key={taskItem.id}
              task={taskItem}
              project={projects.find((p) => p.id === taskItem.projectId) ?? null}
              onEdit={(task) => {
                setEditingTask(task);
                setTaskSheetOpen(true);
              }}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setEditingTask(null);
            setTaskSheetOpen(true);
          }}
          className="mt-2 flex items-center gap-1.5 px-1 py-2 text-sm font-medium text-lh-accent"
        >
          <Plus size={ICON.action} /> {t('Задача')}
        </button>
      </section>

      <section className="mt-6">
        <SectionHeader
          title={t('Обучение')}
          actionLabel={t('Привязать')}
          onAction={() => setLinkLearningOpen(true)}
        />
        {linkedLearning.length === 0 && (
          <p className="px-1 text-sm text-lh-text-secondary">{t('Нет привязанных материалов.')}</p>
        )}
        <div className="flex flex-col gap-2">
          {linkedLearning.map((li: LearningItem) => {
            const Icon = KIND_ICONS[li.kind];
            return (
              <div
                key={li.id}
                className="flex items-center gap-3 card p-3.5"
              >
                <Icon size={ICON.base} className="shrink-0 text-lh-text-secondary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium">{li.title}</p>
                  <div className="mt-1.5">
                    <ProgressBar
                      value={
                        li.progressTarget > 0
                          ? (li.progressCurrent / li.progressTarget) * 100
                          : 0
                      }
                      color={goal.color}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={t('Отвязать')}
                  onClick={() => update(db.learningItems, li.id, { goalId: null })}
                  className={`p-1.5 text-lh-text-secondary ${HIT_SLOP_44}`}
                >
                  <X size={ICON.action} />
                </button>
              </div>
            );
          })}
        </div>
      </section>

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
