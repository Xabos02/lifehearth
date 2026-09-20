import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLoaded } from '../../hooks/useLoaded';
import {
  GChevronRight as ChevronRight,
  GPlus as Plus,
} from '../../components/ui/glyphs';
import { Bell } from 'lucide-react';
import { db } from '../../db/db';
import type { FamilyTask } from '../../db/types';
import { TaskCheck } from '../../components/ui/Checkbox';
import { Button } from '../../components/ui/Button';
import { formatDueDate, todayKey } from '../../lib/dates';
import { toggleFamilyTask, reorderFamilyTasks } from '../../lib/family/familyRepo';
import { cancelReminder } from '../../lib/push';
import { FamilyTaskSheet } from './FamilyTaskSheet';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

const PRIORITY_BAR: Record<number, string> = {
  3: 'bg-danger',
  2: 'bg-warning',
  1: 'bg-muted',
  0: 'bg-transparent',
};

const LONG_PRESS_MS = 400;
const DRAG_CANCEL_MOVE = 8;

export function FamilyTasksTab({ familyId }: { familyId: string }) {
  const tasksRaw = useLiveQuery(() => db.familyTasks.where('familyId').equals(familyId).toArray(), [familyId]);
  const loaded = useLoaded(tasksRaw);
  const membersRaw = useLiveQuery(() => db.familyMembers.where('familyId').equals(familyId).toArray(), [familyId]);
  const members = useMemo(() => membersRaw ?? [], [membersRaw]);
  const memberMap = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members]);

  const tasks = useMemo(() => (tasksRaw ?? []).filter((task) => !task.deletedAt), [tasksRaw]);
  const activeSorted = useMemo(
    () => tasks.filter((task) => !task.completedAt).sort((a, b) => b.sortOrder - a.sortOrder),
    [tasks],
  );
  const completed = useMemo(
    () => tasks.filter((task) => task.completedAt).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')),
    [tasks],
  );

  // Во время переноса пальцем список рисуется в этом порядке, а не в порядке
  // из базы: sortOrder меняется на pointerup одной пачкой, а не на каждый шаг
  // жеста — иначе live-запрос перерисовывал бы список поверх жеста.
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const activeMap = useMemo(() => Object.fromEntries(activeSorted.map((t) => [t.id, t])), [activeSorted]);
  const active = useMemo(() => {
    if (!dragOrder) return activeSorted;
    return dragOrder.map((id) => activeMap[id]).filter((t): t is FamilyTask => Boolean(t));
  }, [dragOrder, activeSorted, activeMap]);

  const [editing, setEditing] = useState<FamilyTask | null>(null);
  const [open, setOpen] = useState(false);
  const [showDone, setShowDone] = useState(false); // выполненные свёрнуты по умолчанию
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pressState = useRef<{
    id: string;
    x: number;
    y: number;
    pointerId: number;
    timer: number | null;
    fired: boolean;
  } | null>(null);

  const openNew = () => {
    setEditing(null);
    setOpen(true);
  };
  const openEdit = (task: FamilyTask) => {
    setEditing(task);
    setOpen(true);
  };

  const clearPress = () => {
    const st = pressState.current;
    if (st?.timer != null) window.clearTimeout(st.timer);
    pressState.current = null;
    window.removeEventListener('pointerup', clearPress);
    window.removeEventListener('pointercancel', clearPress);
  };

  const finishDrag = (order: string[] | null) => {
    setDraggingId(null);
    setDragOrder(null);
    if (order && order.length > 1) void reorderFamilyTasks(familyId, order);
  };

  const onRowPointerDown = (task: FamilyTask, e: ReactPointerEvent<HTMLDivElement>) => {
    if (active.length < 2) return;
    clearPress();
    pressState.current = { id: task.id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, timer: null, fired: false };
    pressState.current.timer = window.setTimeout(() => {
      if (!pressState.current) return;
      pressState.current.fired = true;
      setDraggingId(task.id);
      setDragOrder(active.map((t) => t.id));
    }, LONG_PRESS_MS);
    window.addEventListener('pointerup', clearPress);
    window.addEventListener('pointercancel', clearPress);
  };

  const onRowPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const st = pressState.current;
    if (!st) return;
    if (!draggingId) {
      if (Math.abs(e.clientX - st.x) > DRAG_CANCEL_MOVE || Math.abs(e.clientY - st.y) > DRAG_CANCEL_MOVE) {
        clearPress();
      }
      return;
    }
    // Ищем строку, чей центр пересёк палец — она и указывает новую позицию.
    let order = dragOrder;
    if (!order) return;
    const y = e.clientY;
    let targetIdx = -1;
    for (let i = 0; i < order.length; i++) {
      const el = rowRefs.current.get(order[i]);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) {
        targetIdx = i;
        break;
      }
    }
    if (targetIdx === -1) return;
    const fromIdx = order.indexOf(draggingId);
    if (fromIdx === -1 || fromIdx === targetIdx) return;
    order = order.slice();
    order.splice(fromIdx, 1);
    order.splice(targetIdx, 0, draggingId);
    setDragOrder(order);
  };

  const onRowPointerUp = () => {
    const wasDragging = draggingId != null;
    const order = dragOrder;
    clearPress();
    if (wasDragging) finishDrag(order);
  };

  const renderRow = (task: FamilyTask) => {
    const done = !!task.completedAt;
    const assignee = task.assigneeId ? memberMap[task.assigneeId] : null;
    const author = memberMap[task.createdBy];
    const overdue = !done && task.dueDate !== null && task.dueDate < todayKey();
    const dragSource = draggingId === task.id;
    return (
      <div
        key={task.id}
        ref={(el) => {
          if (el) rowRefs.current.set(task.id, el);
          else rowRefs.current.delete(task.id);
        }}
        role="button"
        tabIndex={0}
        aria-label={t('Изменить задачу')}
        onClick={() => {
          if (pressState.current?.fired) return;
          openEdit(task);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openEdit(task);
          }
        }}
        onPointerDown={(e) => onRowPointerDown(task, e)}
        onPointerMove={onRowPointerMove}
        onPointerUp={onRowPointerUp}
        onPointerCancel={onRowPointerUp}
        style={{ touchAction: dragSource ? 'none' : undefined }}
        className={`flex touch-pan-y items-start gap-3 py-3 transition-[opacity,transform] active:opacity-80 ${
          dragSource ? 'z-10 scale-[0.98] opacity-70 shadow-lg' : ''
        }`}
      >
        {!done && (
          <span className={`mt-1 h-9 w-1 shrink-0 self-stretch rounded-full ${task.color ? '' : PRIORITY_BAR[task.priority]}`} style={task.color ? { background: task.color } : undefined} />
        )}
        <TaskCheck
          checked={done}
          onChange={() => {
            void cancelReminder(task.id);
            void toggleFamilyTask(familyId, task);
          }}
          color={task.color ?? assignee?.color}
        />
        <div className="min-w-0 flex-1">
          <p className={`break-words ${done ? 'text-muted line-through' : 'font-medium'}`}>{task.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            {author && <span>{t('от {name}', { name: author.displayName })}</span>}
            <span style={assignee ? { color: assignee.color } : undefined}>
              → {assignee ? assignee.displayName : t('всем')}
            </span>
            {task.dueDate && (
              <span className={overdue ? 'font-medium text-danger' : ''}>· {formatDueDate(task.dueDate)}</span>
            )}
            {task.remindBefore != null && task.dueDate && (
              <span className="flex items-center" aria-label={t('Напоминание включено')}>
                <Bell size={ICON.inline} />
              </span>
            )}
          </p>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <Button onClick={openNew} className="w-full inline-flex items-center justify-center gap-2">
        <Plus size={ICON.base} />
        {t('Новая задача')}
      </Button>

      {active.length === 0 && completed.length === 0 ? (
        loaded && <p className="py-10 text-center text-sm text-muted">{t('Пока нет общих задач.')}</p>
      ) : (
        <>
          {active.length > 0 && <div className="card divide-y divide-hairline px-4">{active.map(renderRow)}</div>}

          {completed.length > 0 && (
            <div>
              <button
                onClick={() => setShowDone((v) => !v)}
                className="flex w-full items-center gap-1.5 px-1 py-1 text-left text-sm text-muted active:opacity-60"
              >
                <ChevronRight size={ICON.inline} className={`shrink-0 transition-transform ${showDone ? 'rotate-90' : ''}`} />
                <span>{t('Выполненные')}</span>
                <span className="text-xs">{completed.length}</span>
              </button>
              {showDone && (
                <div className="card mt-1 divide-y divide-hairline px-4 opacity-70">{completed.map(renderRow)}</div>
              )}
            </div>
          )}
        </>
      )}

      <FamilyTaskSheet familyId={familyId} open={open} onClose={() => setOpen(false)} task={editing} members={members} />
    </div>
  );
}
