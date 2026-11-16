import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
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
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { formatDueDate, todayKey } from '../../lib/dates';
import { toggleFamilyTask, reorderFamilyTasks } from '../../lib/family/familyRepo';
import { FamilyTaskSheet } from './FamilyTaskSheet';
import { MemberAvatar, GroupAvatar } from './MemberAvatar';
import { getFamilyConfig } from '../../lib/family/familyState';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import { buzz } from '../../lib/feedback';

const PRIORITY_BAR: Record<number, string> = {
  3: 'bg-danger',
  2: 'bg-warning',
  1: 'bg-lh-text-tertiary',
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
  const selfId = useLiveQuery(() => getFamilyConfig(familyId), [familyId])?.selfMemberId;
  // Фильтр макета «Общие задачи»: все, мне, я поручил. Перенос пальцем — только
  // во «Все»: в отфильтрованном списке место строки не равно месту в общем порядке.
  const [filter, setFilter] = useState<'all' | 'mine' | 'byMe'>('all');

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
  const ordered = useMemo(() => {
    if (!dragOrder) return activeSorted;
    return dragOrder.map((id) => activeMap[id]).filter((t): t is FamilyTask => Boolean(t));
  }, [dragOrder, activeSorted, activeMap]);
  const matches = (task: FamilyTask) =>
    filter === 'all' || (filter === 'mine' ? task.assigneeId === selfId : task.createdBy === selfId);
  const active = filter === 'all' ? ordered : ordered.filter(matches);
  // Выполненные — под тем же фильтром, что и открытые: иначе на «Мне» висели
  // «Пока нет общих задач» при чужих открытых и счётчик «Выполненные 5» над
  // пустой карточкой.
  const completedShown = filter === 'all' ? completed : completed.filter(matches);
  const mineCount = selfId ? activeSorted.filter((x) => x.assigneeId === selfId).length : 0;

  const [editing, setEditing] = useState<FamilyTask | null>(null);
  const [open, setOpen] = useState(false);
  const [showDone, setShowDone] = useState(false); // выполненные свёрнуты по умолчанию
  const listRef = useRef<HTMLDivElement>(null);
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
  // Номер переноса: порядок жеста снимаем, когда запись легла в базу, — если
  // за это время не начался следующий перенос.
  const dragSeq = useRef(0);
  // Снимает слушатели окна идущего переноса; null — переноса нет.
  const stopDrag = useRef<(() => void) | null>(null);

  // Вкладку закрыли посреди жеста: ни таймер удержания, ни слушатели окна (а с
  // ними и глушение прокрутки) не должны пережить экран.
  useEffect(
    () => () => {
      const st = pressState.current;
      if (st?.timer != null) window.clearTimeout(st.timer);
      stopDrag.current?.();
    },
    [],
  );

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
    if (task.completedAt || active.length < 2 || filter !== 'all') return;
    clearPress();
    const row = e.currentTarget;
    pressState.current = { id: task.id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, timer: null };
    pressState.current.timer = window.setTimeout(() => {
      const st = pressState.current;
      if (!st) return;
      clearPress(); // удержание сработало: дальше жест ведут обработчики окна
      longFired.current = true;
      buzz(); // «взял» — только Android, PROTOCOL §6.4
      startDrag(task.id, st.pointerId);
      // Палец ещё неподвижен — захватываем его на строке, как строка личной
      // задачи (TaskItem). Ведение и отпускание ловит окно (startDrag), и в
      // Chromium перенос работает и без захвата; он оставлен подстраховкой для
      // iPhone, где проверить нечем.
      try {
        row.setPointerCapture(st.pointerId);
      } catch {
        /* указатель уже отпущен */
      }
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
  //
  // Вешаются они в миг подъёма, из таймера удержания, а не эффектом после
  // отрисовки: палец, отпущенный между таймером и эффектом (в замере 14–29 мс),
  // терялся — строка залипала поднятой, а прокрутка страницы оставалась
  // заглушённой. Порядок жеста живёт здесь же, в замыкании: отпускание в
  // одном кадре с последним движением брало порядок из прошлой отрисовки и
  // записывало задачу на шаг раньше того места, где её отпустили.
  const startDrag = (id: string, pointerId: number) => {
    const seq = ++dragSeq.current;
    let order = active.map((t) => t.id);
    const before = order; // move не правит массив на месте, а строит новый
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      // Место — номер строки под пальцем в разметке. Порядок может опережать
      // отрисовку на шаг, но «задача встаёт на место номер at» от этого не
      // зависит.
      const at = Array.from(listRef.current?.children ?? []).findIndex((el) => {
        const r = el.getBoundingClientRect();
        return e.clientY >= r.top && e.clientY <= r.bottom;
      });
      if (at === -1 || order[at] === id) return;
      order = order.filter((x) => x !== id);
      order.splice(at, 0, id);
      setDragOrder(order);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      stop();
      setDraggingId(null);
      // Системный обрыв жеста (звонок, шторка) — не «отпустил над целью»:
      // раньше он записывал порядок, в котором строки оказались в тот миг.
      if (e.type === 'pointercancel') {
        setDragOrder(null);
        return;
      }
      // Задача встала на новое место — короткая вибрация, только Android
      // (PROTOCOL §6.4); отпустил там же, где взял, — молчим.
      if (order.some((x, i) => x !== before[i])) buzz();
      // Порядок жеста держим, пока запись не легла в базу: иначе список на миг
      // возвращался к старому порядку и прыгал обратно.
      void reorderFamilyTasks(familyId, order).finally(() => {
        if (dragSeq.current === seq) setDragOrder(null);
      });
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('touchmove', blockScroll);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      stopDrag.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('touchmove', blockScroll, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    stopDrag.current = stop;
    setDraggingId(id);
    setDragOrder(order);
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
        role="button"
        tabIndex={0}
        aria-label={t('Изменить задачу')}
        data-dragging={dragSource || undefined}
        onClick={() => {
          if (longFired.current) {
            longFired.current = false;
            return;
          }
          openEdit(task);
        }}
        onKeyDown={(e) => {
          // Enter на галочке всплывает сюда, и preventDefault погасил бы её
          // собственный клик.
          if (e.target !== e.currentTarget) return;
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
        className={`relative flex touch-pan-y select-none items-start gap-3 py-3.5 pr-3 pl-4 transition-[opacity,transform] active:bg-lh-surface-2 [-webkit-touch-callout:none] [-webkit-user-select:none] ${
          dragSource ? 'z-10 scale-[0.98] opacity-70 shadow-lg' : ''
        }`}
      >
        {/* Приоритет — тонкой полосой у края карточки, а не отдельной колонкой. */}
        {!done && (task.color || task.priority > 0) && (
          <span
            aria-hidden
            className={`absolute top-3 bottom-3 left-0 w-1 rounded-r-sm ${task.color ? '' : PRIORITY_BAR[task.priority]}`}
            style={task.color ? { background: task.color } : undefined}
          />
        )}
        <TaskCheck
          checked={done}
          onChange={() => {
            // Кружок лежит в строке, и удержание на нём тоже берёт задачу. Клик
            // после такого отпускания — конец жеста, а не отметка: иначе
            // «взял и передумал» выполнял задачу и слал семье пуш об этом.
            if (longFired.current) {
              longFired.current = false;
              return false; // и без щелчка: отметка не изменилась
            }
            void toggleFamilyTask(familyId, task);
          }}
          color={task.color ?? assignee?.color}
        />
        <div className="min-w-0 flex-1">
          <p className={`break-words leading-snug ${done ? 'text-lh-text-secondary line-through' : ''}`}>{task.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-lh-text-secondary">
            {author && <span>{t('от {name}', { name: author.displayName })}</span>}
            {/* Цвет исполнителя — только в тёмной теме, в светлой muted (§1.8):
                лаймовый на белой карточке давал 1.51. */}
            <span className="member-color" style={assignee ? ({ '--member-color': assignee.color } as CSSProperties) : undefined}>
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
        {!done && (assignee ? <MemberAvatar member={assignee} className="mt-0.5 size-7 text-2xs" /> : <GroupAvatar className="mt-0.5 size-7" glyph={ICON.inline} />)}
      </div>
    );
  };

  return (
    <div className="space-y-5 pb-4">
      <p className="-mt-2 text-xs leading-relaxed text-lh-text-secondary">
        {t('Видны всем в группе')}
      </p>
      <SegmentedControl
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: activeSorted.length > 0 ? t('Все · {n}', { n: activeSorted.length }) : t('Все') },
          { value: 'mine', label: mineCount > 0 ? t('Мне · {n}', { n: mineCount }) : t('Мне') },
          { value: 'byMe', label: t('Я поручил') },
        ]}
      />
      <Button onClick={openNew} className="w-full">
        <Plus size={ICON.base} />
        {t('Новая задача')}
      </Button>

      {active.length === 0 && completedShown.length === 0 ? (
        loaded && (
          <p className="py-10 text-center text-sm text-lh-text-secondary">
            {filter === 'all' ? t('Пока нет общих задач.') : t('Здесь пока пусто.')}
          </p>
        )
      ) : (
        <>
          {active.length > 0 ? (
            <div ref={listRef} className="card divide-y divide-lh-border">
              {active.map(renderRow)}
            </div>
          ) : (
            loaded && <p className="py-6 text-center text-sm text-lh-text-secondary">{t('Здесь пока пусто.')}</p>
          )}

          {completedShown.length > 0 && (
            <section>
              <button
                onClick={() => setShowDone((v) => !v)}
                aria-expanded={showDone}
                className="mb-2.5 flex min-h-11 w-full items-center justify-between px-1 text-left active:opacity-60"
              >
                <span className="lh-section">{t('Выполненные')}</span>
                <span className="flex items-center gap-1 text-xs text-lh-text-secondary">
                  {completedShown.length}
                  <ChevronRight size={ICON.inline} className={`shrink-0 transition-transform ${showDone ? 'rotate-90' : ''}`} />
                </span>
              </button>
              {showDone && (
                <div className="card divide-y divide-lh-border">{completedShown.map(renderRow)}</div>
              )}
            </section>
          )}
        </>
      )}

      <FamilyTaskSheet familyId={familyId} open={open} onClose={() => setOpen(false)} task={editing} members={members} />
    </div>
  );
}
