import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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

// Пока задачу тащат, страница не прокручивается. Без этого вертикальное
// движение пальца забирал себе браузер: приходил pointercancel, и пальцем
// задача не переносилась вовсе — работала только мышь. Тот же приём, что у
// переноса в «Задачах» (TasksPage).
const blockScroll = (e: TouchEvent) => e.preventDefault();

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
  } | null>(null);
  // Удержание сработало: клик, который браузер пришлёт после отпускания, —
  // конец жеста, а не тап по задаче. Раньше флаг жил в pressState, а тот
  // обнулялся на pointerup — раньше клика, и карточка задачи открывалась.
  const longFired = useRef(false);
  const dragPointer = useRef(0);
  // Номер переноса: порядок жеста снимаем, когда запись легла в базу, — если
  // за это время не начался следующий перенос.
  const dragSeq = useRef(0);

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

  const onRowPointerDown = (task: FamilyTask, e: ReactPointerEvent<HTMLDivElement>) => {
    longFired.current = false;
    // Выполненные идут по времени выполнения — переставлять там нечего.
    if (task.completedAt || active.length < 2) return;
    clearPress();
    const row = e.currentTarget;
    pressState.current = { id: task.id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, timer: null };
    pressState.current.timer = window.setTimeout(() => {
      const st = pressState.current;
      if (!st) return;
      clearPress(); // удержание сработало: дальше жест ведут обработчики окна
      longFired.current = true;
      dragPointer.current = st.pointerId;
      dragSeq.current++;
      // Палец ещё неподвижен — захватываем его на строке, как строка личной
      // задачи (TaskItem). Ведение и отпускание ловит окно (эффект ниже), и в
      // Chromium перенос работает и без захвата; он оставлен подстраховкой для
      // iPhone, где проверить нечем.
      try {
        row.setPointerCapture(st.pointerId);
      } catch {
        /* указатель уже отпущен */
      }
      setDraggingId(task.id);
      setDragOrder(active.map((t) => t.id));
    }, LONG_PRESS_MS);
    window.addEventListener('pointerup', clearPress);
    window.addEventListener('pointercancel', clearPress);
  };

  // До срабатывания удержания движение пальца — это прокрутка, а не перенос.
  const onRowPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const st = pressState.current;
    if (!st) return;
    if (Math.abs(e.clientX - st.x) > DRAG_CANCEL_MOVE || Math.abs(e.clientY - st.y) > DRAG_CANCEL_MOVE) {
      clearPress();
    }
  };

  // Сам перенос ведут обработчики окна, а не строки: строку под пальцем React
  // переставляет в DOM, а отпускание может прийти мимо любой строки — раньше
  // тогда перенос не заканчивался, и строка так и оставалась «поднятой».
  useEffect(() => {
    if (!draggingId || !dragOrder) return;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== dragPointer.current) return;
      // Ищем строку, чей центр пересёк палец — она и указывает новую позицию.
      let targetIdx = -1;
      for (let i = 0; i < dragOrder.length; i++) {
        const el = rowRefs.current.get(dragOrder[i]);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx === -1) return;
      const fromIdx = dragOrder.indexOf(draggingId);
      if (fromIdx === -1 || fromIdx === targetIdx) return;
      const order = dragOrder.slice();
      order.splice(fromIdx, 1);
      order.splice(targetIdx, 0, draggingId);
      setDragOrder(order);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== dragPointer.current) return;
      setDraggingId(null);
      // Системный обрыв жеста (звонок, шторка) — не «отпустил над целью»:
      // раньше он записывал порядок, в котором строки оказались в тот миг.
      if (e.type === 'pointercancel') {
        setDragOrder(null);
        return;
      }
      // Порядок жеста держим, пока запись не легла в базу: иначе список на миг
      // возвращался к старому порядку и прыгал обратно.
      const seq = dragSeq.current;
      void reorderFamilyTasks(familyId, dragOrder).finally(() => {
        if (dragSeq.current === seq) setDragOrder(null);
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('touchmove', blockScroll, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('touchmove', blockScroll);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [draggingId, dragOrder, familyId]);

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
          if (longFired.current) {
            longFired.current = false;
            return;
          }
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
        style={{ touchAction: dragSource ? 'none' : undefined }}
        // select-none и без системного меню: на iPhone удержание строки иначе
        // выделяло текст названия вместо того, чтобы взять задачу.
        className={`flex touch-pan-y select-none items-start gap-3 py-3 transition-[opacity,transform] active:opacity-80 [-webkit-touch-callout:none] [-webkit-user-select:none] ${
          dragSource ? 'z-10 scale-[0.98] opacity-70 shadow-lg' : ''
        }`}
      >
        {!done && (
          <span className={`mt-1 h-9 w-1 shrink-0 self-stretch rounded-full ${task.color ? '' : PRIORITY_BAR[task.priority]}`} style={task.color ? { background: task.color } : undefined} />
        )}
        <TaskCheck
          checked={done}
          onChange={() => {
            // Кружок лежит в строке, и удержание на нём тоже берёт задачу. Клик
            // после такого отпускания — конец жеста, а не отметка: иначе
            // «взял и передумал» выполнял задачу и слал семье пуш об этом.
            if (longFired.current) {
              longFired.current = false;
              return;
            }
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
