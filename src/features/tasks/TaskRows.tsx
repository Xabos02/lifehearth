import { Fragment } from 'react';
import { Repeat } from 'lucide-react';
import {
  GChevronDown as ChevronDown,
  GChevronRight as ChevronRight,
  GFolder as Folder,
  GPlus as Plus,
  GSun as Sun,
  GFolderPlus as FolderPlus,
  GSnowflake as Snowflake,
} from '../../components/ui/glyphs';
import type { Project, Task } from '../../db/types';
import { t } from '../../lib/i18n';
import { describeRecurrence } from '../../lib/recurrence';
import { TaskItem } from './TaskItem';
import { ICON, STROKE } from '../../components/ui/icons';
import { useToast } from '../../components/ui/toastContext';
import { formatDueDate } from '../../lib/dates';
import { unfreezeAll, unfreezeTask } from './taskActions';

// Строки и мелкие блоки раздела «Задачи»: иконка папки проекта, карточка
// задачи, линии вставки при переносе, строка «+ Задача», свёрнутые группы
// выполненных и замороженных.
//
// Вынесено из TasksPage.tsx перемещением, без изменения логики: файл экрана
// дорос до 1777 строк, и правки владельца приходятся в том числе сюда.
// Комментарии сохранены целиком — в них причины, по которым эти блоки
// выглядят именно так.

/** Иконка папки проекта: стандартная 📁 заменяется папкой в цвете проекта —
 *  выбранный при создании цвет виден прямо в списке. Своё эмодзи — как есть. */
export function ProjectFolderIcon({ project, size = 18 }: { project: Project; size?: number }) {
  const emoji = project.emoji?.trim();
  if (emoji && emoji !== '📁')
    return <span style={{ fontSize: size - 1 }} className="leading-none">{emoji}</span>;
  return (
    <Folder
      size={size}
      aria-hidden
      strokeWidth={STROKE}
      style={{ color: project.color, fill: project.color }}
    />
  );
}

/** Вложенная секция подпроекта внутри секции родителя: свой заголовок с цветной
 *  папкой, счётчиком и карандашом, свои задачи и «+ Задача». Тоже drop-зона —
 *  задачу можно перетащить прямо в подпроект. */

/** Тонкая линия-индикатор вставки задачи между строками. */
export function TaskDropLine() {
  return (
    <div className="my-1.5 h-1 rounded-full bg-accent" aria-hidden />
  );
}

export function TaskCard({
  tasks,
  projectById,
  onEdit,
  muted,
  onDragStart,
  draggingId,
  dropIndex,
  dividerAt,
}: {
  tasks: Task[];
  projectById: Map<string, Project>;
  onEdit: (task: Task) => void;
  muted?: boolean;
  /** Передаётся только в активных секциях — включает drag переноса. */
  onDragStart?: (task: Task, at: { x: number; y: number; pointerId: number }) => void;
  /** id перетаскиваемой задачи для визуального сигнала источника. */
  draggingId?: string | null;
  /** Зазор вставки перетаскиваемой задачи (0..N) — рисуем линию. null — нет. */
  dropIndex?: number | null;
  /** С какого места начинаются временные задачи — там подпись. null — нет. */
  dividerAt?: number | null;
}) {
  return (
    <div
      className={`card divide-y divide-hairline px-4 ${muted ? 'opacity-60' : ''}`}
    >
      {tasks.map((task, i) => (
        <Fragment key={task.id}>
          {dividerAt === i && (
            // Подпись, а не вторая карточка: разрыв на два блока сломал бы
            // счёт зазора вставки при переносе, а глазу хватает и строки.
            <p className="px-0 pt-3 pb-1 text-2xs font-semibold tracking-wide text-muted uppercase">
              {t('Временные')}
            </p>
          )}
          {dropIndex === i && <TaskDropLine />}
          <TaskItem
            task={task}
            project={task.projectId ? (projectById.get(task.projectId) ?? null) : null}
            onEdit={onEdit}
            onDragStart={onDragStart}
            isDragSource={draggingId === task.id}
            hideProject
          />
        </Fragment>
      ))}
      {dropIndex === tasks.length && <TaskDropLine />}
    </div>
  );
}

/** Свёрнутая по умолчанию под-секция выполненных задач внутри группы (#13). */
export function CompletedSubsection({
  tasks,
  projectById,
  onEdit,
  expanded,
  onToggle,
}: {
  tasks: Task[];
  projectById: Map<string, Project>;
  onEdit: (task: Task) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="mt-2">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-1 py-2.5 text-left text-sm text-muted active:opacity-60"
      >
        <ChevronRight
          size={ICON.inline}
          className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span>{t('Выполненные')}</span>
        <span className="text-xs">{tasks.length}</span>
      </button>
      {/* Раскрывается прямо в поток, без своей прокрутки.
          
          Была коробка max-h-72 с overflow-y-auto: 288 пикселей со вторым
          скроллом ВНУТРИ страничного. Палец, крутящий список, попадал в неё и
          вместо страницы прокручивал коробку — список под пальцем застревал
          без всякой причины. Длинный список выполненных лучше листать вместе
          со всей страницей: он всё равно свёрнут по умолчанию. */}
      {expanded && (
        <div className="mt-1">
          <TaskCard tasks={tasks} projectById={projectById} onEdit={onEdit} muted />
        </div>
      )}
    </div>
  );
}

/** Секция «Заморожено» — задачи на паузе. Каждую можно разморозить, либо все разом. */
export function FrozenSection({
  tasks,
  projectById,
  collapsed,
  onToggle,
  onEdit,
}: {
  tasks: Task[];
  projectById: Map<string, Project>;
  collapsed: boolean;
  onToggle: () => void;
  onEdit: (task: Task) => void;
}) {
  const toast = useToast();
  return (
    <section className="mb-12">
      <div className="mb-2 flex items-center gap-1 px-1">
        <button onClick={onToggle} className="flex flex-1 items-center gap-1.5 py-2.5 text-left">
          <ChevronDown
            size={ICON.base}
            className={`shrink-0 text-muted transition-transform ${collapsed ? '-rotate-90' : ''}`}
          />
          <Snowflake size={ICON.action} className="shrink-0 text-frost" />
          <h2 className="text-lg font-bold tracking-tight">{t('Заморожено')}</h2>
          <span className="text-sm text-muted">{tasks.length}</span>
        </button>
        <button
          onClick={() => void unfreezeAll().then(() => toast(t('Все задачи разморожены')))}
          className="shrink-0 px-2 py-1 text-sm font-medium text-frost active:opacity-60"
        >
          {t('Разморозить всё')}
        </button>
      </div>
      {!collapsed && (
        <div className="card divide-y divide-hairline px-4">
          {tasks.map((task) => {
            const project = task.projectId ? projectById.get(task.projectId) : null;
            return (
              <div key={task.id} className="flex items-center gap-3 py-3">
                <button onClick={() => onEdit(task)} className="min-w-0 flex-1 text-left active:opacity-70">
                  <p lang="ru" className="break-words text-pretty hyphens-auto font-medium">{task.title}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                    {task.dueDate && (
                      <span>
                        {formatDueDate(task.dueDate)}
                        {task.dueTime ? `, ${task.dueTime}` : ''}
                      </span>
                    )}
                    {task.recurrence && (
                      <span className="flex items-center gap-0.5">
                        <Repeat size={ICON.inline} />
                        {describeRecurrence(task.recurrence)}
                      </span>
                    )}
                    {project && (
                      <span className="truncate">
                        {project.emoji} {project.name}
                      </span>
                    )}
                  </div>
                </button>
                <button
                  onClick={() => void unfreezeTask(task).then(() => toast(t('Разморожено')))}
                  aria-label={t('Разморозить задачу')}
                  // Тёплое солнце-«разморозка» — контраст к голубой теме секции.
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning active:opacity-70"
                >
                  <Sun size={ICON.action} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Линия-индикатор вставки при перетаскивании проекта — показывает, куда он встанет. */
export function DropLine() {
  return (
    <div className="mx-1 mb-4 flex items-center gap-2" aria-hidden>
      <span className="size-3 shrink-0 rounded-full bg-accent" />
      <span className="h-1.5 flex-1 rounded-full bg-accent" />
    </div>
  );
}

export function AddTaskRow({ onClick, onAddSubproject }: { onClick: () => void; onAddSubproject?: () => void }) {
  return (
    <div className="mt-1.5 flex items-center gap-4">
      <button
        onClick={onClick}
        aria-label={t('Добавить задачу')}
        className="flex items-center gap-1.5 px-1 py-3 text-sm font-medium text-accent active:opacity-60"
      >
        <Plus size={ICON.inline} /> {t('Задача')}
      </button>
      {onAddSubproject && (
        <button
          onClick={onAddSubproject}
          aria-label={t('Добавить подпроект')}
          className="flex items-center gap-1.5 px-1 py-3 text-sm font-medium text-muted active:opacity-60"
        >
          <FolderPlus size={ICON.inline} /> {t('Подпроект')}
        </button>
      )}
    </div>
  );
}
