import { useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  GCheck as Check,
  GFolder as Folder,
  GSnowflake as Snowflake,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { Project, Task } from '../../db/types';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/toastContext';
import { formatDueDate } from '../../lib/dates';
import { formatDueRange } from '../../lib/taskDates';
import { freezeTasks } from './taskActions';
import { ICON, STROKE, STROKE_HEAVY } from '../../components/ui/icons';
import { t } from '../../lib/i18n';

// Строки списка: заголовок группы (проект/подпроект/«Без проекта») или задача.
type Row =
  | { type: 'header'; key: string; project: Project | null; depth: number; count: number }
  | { type: 'task'; task: Task; depth: number };

/** Иконка папки — как в разделе задач: стандартная 📁 → папка в цвете проекта. */
function GroupIcon({ project, size = 15 }: { project: Project | null; size?: number }) {
  if (!project) return <Folder size={size} aria-hidden className="text-muted" />;
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

/** Лист выбора задач для заморозки: та же структура, что в разделе «Задачи» —
 *  проекты (с подпроектами) в своём порядке, внутри — активные задачи. */
export function FreezeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const tasks = alive(useLiveQuery(() => db.tasks.toArray(), []) ?? []);
  const projects = alive(useLiveQuery(() => db.projects.toArray(), []) ?? [])
    .filter((p) => !p.archivedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const rows = useMemo<Row[]>(() => {
    const projectIds = new Set(projects.map((p) => p.id));
    // Кандидаты: активные (не выполненные, не замороженные), в порядке раздела.
    const byProject = new Map<string, Task[]>();
    for (const task of tasks) {
      if (task.completedAt || task.frozenAt) continue;
      // Проект задачи архивирован (или удалён) — задачу исключаем совсем, а не
      // сваливаем в «Без проекта». На главном экране секции строятся только по
      // живым неархивным проектам, так что такая задача там уже не видна —
      // архивация проекта уже поставила на паузу все его задачи разом. Шит
      // обязан быть консистентен с главным экраном; «Без проекта» — только для
      // настоящего projectId === null.
      if (task.projectId && !projectIds.has(task.projectId)) continue;
      const key = task.projectId ?? '';
      const arr = byProject.get(key);
      if (arr) arr.push(task);
      else byProject.set(key, [task]);
    }
    for (const arr of byProject.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder);

    // Иерархия как на странице задач: верхний уровень + подпроекты.
    const tops = projects.filter((p) => !p.parentId || !projectIds.has(p.parentId));
    const childrenOf = (id: string) => projects.filter((p) => p.parentId === id);

    const out: Row[] = [];
    // Рекурсия по всем уровням: обход останавливался на втором, и задачи из
    // папок третьего уровня заморозить было нельзя вовсе.
    const hasTasksDeep = (p: Project): boolean =>
      (byProject.get(p.id) ?? []).length > 0 || childrenOf(p.id).some(hasTasksDeep);
    const pushGroup = (p: Project, depth: number) => {
      const list = byProject.get(p.id) ?? [];
      if (!hasTasksDeep(p)) return;
      out.push({ type: 'header', key: p.id, project: p, depth, count: list.length });
      for (const task of list) out.push({ type: 'task', task, depth });
      for (const k of childrenOf(p.id)) pushGroup(k, depth + 1);
    };
    for (const p of tops) pushGroup(p, 0);
    const none = byProject.get('') ?? [];
    if (none.length) {
      out.push({ type: 'header', key: '', project: null, depth: 0, count: none.length });
      for (const task of none) out.push({ type: 'task', task, depth: 0 });
    }
    return out;
  }, [tasks, projects]);

  const candidateIds = useMemo(
    () => rows.filter((r) => r.type === 'task').map((r) => (r as { task: Task }).task.id),
    [rows],
  );

  // Сброс выбора при открытии обеспечивает remount по key из родителя.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function confirm() {
    const ids = new Set(candidateIds.filter((id) => selected.has(id)));
    const toFreeze = tasks.filter((task) => ids.has(task.id));
    if (!toFreeze.length) return;
    await freezeTasks(toFreeze);
    toast(
      toFreeze.length === 1
        ? t('Задача заморожена')
        : t('Заморожено: {n}', { n: toFreeze.length }),
    );
    onClose();
  }

  function renderRow(row: Row): ReactNode {
    if (row.type === 'header') {
      return (
        <div
          key={`h-${row.key}`}
          className={`flex items-center gap-1.5 bg-surface-2/60 px-3 py-2 ${
            row.depth ? ['', 'pl-8', 'pl-14', 'pl-20'][Math.min(row.depth, 3)] : ''
          }`}
        >
          <GroupIcon project={row.project} />
          <span className={`truncate font-semibold ${row.depth ? 'text-xs' : 'text-sm'}`}>
            {row.project ? row.project.name : t('Без проекта')}
          </span>
          <span className="text-xs text-muted">{row.count}</span>
        </div>
      );
    }
    const task = row.task;
    const on = selected.has(task.id);
    return (
      <button
        key={task.id}
        onClick={() => toggle(task.id)}
        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left active:opacity-70 ${
          row.depth ? ['', 'pl-8', 'pl-14', 'pl-20'][Math.min(row.depth, 3)] : ''
        }`}
      >
        <span
          className={`flex size-5 shrink-0 items-center justify-center rounded-[6px] border transition-colors ${
            on ? 'border-frost-fill bg-frost-fill text-on-light' : 'border-border'
          }`}
        >
          {on && <Check size={ICON.inline} strokeWidth={STROKE_HEAVY} />}
        </span>
        <span className="min-w-0 flex-1">
          <span lang="ru" className="block break-words text-pretty hyphens-auto font-medium">
            {task.title}
          </span>
          <span className="block truncate text-xs text-muted">
            {task.dueDate
              ? task.startDate
                ? formatDueRange(task.startDate, task.dueDate)
                : formatDueDate(task.dueDate)
              : t('без срока')}
          </span>
        </span>
      </button>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('Заморозить задачи')}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          {t(
            'Выберите задачи, чтобы поставить их на паузу. Они исчезнут из списка и статистики и перестанут напоминать — «как будто для них остановилось время». Разморозить можно в любой момент.',
          )}
        </p>
        {candidateIds.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            {t('Нет активных задач для заморозки.')}
          </p>
        ) : (
          // Скролл — на СВОЁМ узле, отдельном от .card. У .card overflow:hidden
          // задан в index.css вне @layer (клип содержимого ради скруглений), а
          // такое правило по каскаду слоёв перебивает любую Tailwind-утилиту
          // (в т.ч. overflow-y-auto) независимо от порядка классов. На одном
          // узле с overflow-y-auto итоговый computed overflow-y всё равно
          // hidden — scrollHeight больше clientHeight, а scrollTop не
          // двигается: список молча не прокручивается дальше первого экрана.
          <div className="card">
            <div className="max-h-[50dvh] divide-y divide-hairline overflow-y-auto">
              {rows.map(renderRow)}
            </div>
          </div>
        )}
        <Button
          className="inline-flex w-full items-center justify-center gap-2"
          disabled={selected.size === 0}
          onClick={() => void confirm()}
        >
          <Snowflake size={ICON.base} />
          {t('Заморозить')}
          {selected.size > 0 ? ` (${selected.size})` : ''}
        </Button>
      </div>
    </Sheet>
  );
}
