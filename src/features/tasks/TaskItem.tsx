import { useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  Bell,
  Repeat,
  SkipForward,
} from 'lucide-react';
import type { Project, Task } from '../../db/types';
import { HIT_SLOP_44, TaskCheck } from '../../components/ui/Checkbox';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { PhotoViewer } from '../../components/ui/PhotoViewer';
import { useToast } from '../../components/ui/toastContext';
import { db } from '../../db/db';
import { remove, update } from '../../db/repo';
import { cancelReminder, scheduleReminder } from '../../lib/push';
import { addDaysKey, formatDueDate, todayKey } from '../../lib/dates';
import { formatDueRange } from '../../lib/taskDates';
import { describeRecurrence } from '../../lib/recurrence';
import { t } from '../../lib/i18n';
import { skipTask, toggleTask } from './taskActions';
import { ICON } from '../../components/ui/icons';
import {
  GSnowflake as Snowflake,
} from '../../components/ui/glyphs';

const PRIORITY_BAR: Record<number, string> = {
  3: 'bg-danger',
  2: 'bg-warning',
  1: 'bg-muted',
  0: 'bg-transparent',
};

/** Прибавляет минуты к 'HH:mm', сворачивая в пределах суток — для конца интервала. */
function addMinutesToTime(hhmm: string, add: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (((h * 60 + m + add) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const ACTIONS_WIDTH = 152; // ширина блока действий слева (две кнопки)
const SWIPE_THRESHOLD = 40; // меньше — считается тапом
const SWIPE_ACTIVATE = 14; // порог распознавания жеста: меньше — ничего не двигаем
const LONG_PRESS_MS = 400; // удержание без движения → старт drag-режима
const DRAG_CANCEL_MOVE = 8; // горизонт/вертикаль сдвиг, отменяющий long-press

/** Строка задачи: чекбокс, заголовок, метаданные. Тап — редактирование,
 *  свайп влево — действия (Завтра/Удалить), свайп вправо — выполнить.
 *  Удержание ~400мс без движения (когда передан onDragStart) — старт
 *  drag-режима переноса между проектами (логику переноса ведёт TasksPage). */
export function TaskItem({
  task,
  project,
  onEdit,
  onDragStart,
  isDragSource = false,
  hideProject = false,
}: {
  task: Task;
  project?: Project | null;
  onEdit?: (t: Task) => void;
  /** Опциональный: вызывается при long-press со стартовыми координатами пальца.
   *  Места без него (Today/Calendar/GoalDetail) просто не получают drag. */
  onDragStart?: (t: Task, at: { x: number; y: number; pointerId: number }) => void;
  /** Управляемый родителем визуальный сигнал «эта задача сейчас тащится». */
  isDragSource?: boolean;
  /** Скрыть метку проекта — на TasksPage задача уже под заголовком проекта. */
  hideProject?: boolean;
}) {
  const toast = useToast();
  const done = Boolean(task.completedAt);
  // Где включён drag — глушим нативное выделение/лупу/callout iOS, иначе
  // удержание шлёт строке pointercancel и перенос срывается.
  const draggable = Boolean(onDragStart);
  const showProject = Boolean(project) && !hideProject;
  const frozen = task.frozenAt != null;
  const overdue = !done && !frozen && task.dueDate !== null && task.dueDate < todayKey();
  const checklistDone = task.checklist.filter((i) => i.done).length;
  const checklistPct = task.checklist.length
    ? (checklistDone / task.checklist.length) * 100
    : 0;
  const hasMeta =
    Boolean(task.dueDate) ||
    Boolean(task.recurrence) ||
    showProject ||
    task.checklist.length > 0 ||
    task.tags.length > 0 ||
    frozen;

  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  // moved — был ли горизонтальный свайп; longPressed — сработал ли long-press
  // (тогда дальнейшие move/up в этой строке игнорируются: жест ведёт TasksPage).
  const drag = useRef({
    x: 0,
    y: 0,
    dx: 0,
    moved: false,
    longPressed: false,
    pointerId: 0,
    axis: 'none' as 'none' | 'x' | 'y', // directional lock: ось жеста, пока не определена — не свайпим
  });
  const [viewerAt, setViewerAt] = useState<number | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const rowRef = useRef<HTMLDivElement>(null);

  // Снять «drag-режим» строки: вернуть touch-action и отпустить захват указателя.
  const endRowDrag = () => {
    const el = rowRef.current;
    if (!el) return;
    el.style.touchAction = '';
    try {
      el.releasePointerCapture(drag.current.pointerId);
    } catch {
      /* указатель уже отпущен */
    }
  };

  // Снятие взведённого удержания живёт в ref: им же вешается и снимается
  // сторож окна, а removeEventListener сверяет функции по идентичности —
  // пересоздай её на рендере, и сторож остался бы висеть.
  const cancelRef = useRef<() => void>(() => {});
  useEffect(() => {
    cancelRef.current = () => {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = undefined;
      window.removeEventListener('pointerup', cancelRef.current);
      window.removeEventListener('pointercancel', cancelRef.current);
    };
    // Подстраховка: снять висящий таймер при размонтировании строки.
    return () => cancelRef.current();
  }, []);
  const clearLongPress = () => cancelRef.current();

  // Отпускание пальца ловим на ОКНЕ, а не только на самой строке.
  //
  // Ровно тот же провал, что уже починен у заголовков проектов: обработчик
  // строки видит отпускание, лишь когда оно пришло в неё. Палец соскользнул на
  // соседнюю строку, список перерисовало, экран сменился — события нет, таймер
  // остаётся взведённым и срабатывает уже ПОСЛЕ конца касания. Перенос задачи
  // начинается без пальца, плашка приклеивается к экрану, и убрать её нечем:
  // pointerup больше не придёт. Окно видит конец касания всегда.
  const armReleaseGuard = () => {
    window.addEventListener('pointerup', cancelRef.current);
    window.addEventListener('pointercancel', cancelRef.current);
  };

  const handleToggle = async () => {
    setDx(0);
    const next = await toggleTask(task);
    if (next) toast(t('Повторится {date}', { date: formatDueDate(next) }));
  };

  const handleTomorrow = () => {
    setDx(0);
    const dueDate = addDaysKey(todayKey(), 1);
    // Начало окна не может оказаться позже нового дедлайна: окно из будущего
    // схлопывается в завтрашний день.
    const startDate = task.startDate && task.startDate > dueDate ? dueDate : (task.startDate ?? null);
    void update(db.tasks, task.id, { dueDate, startDate });
    // Переносим и пуш-напоминание (иначе оно осталось бы на сегодня, а завтра
    // не сработало бы). scheduleReminder сам снимет пуш, если времени нет.
    void scheduleReminder({ ...task, dueDate });
    toast(t('Перенесено на завтра'));
  };

  const handleSkip = async () => {
    setDx(0);
    await skipTask(task);
    toast(
      task.recurrence
        ? t('Пропущено · к следующему повтору')
        : t('Пропущено · перенесено на сегодня'),
    );
  };

  const handleDelete = () => {
    if (window.confirm(t('Удалить задачу?'))) {
      void cancelReminder(task.id);
      void remove(db.tasks, task.id);
    } else setDx(0);
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      dx,
      moved: false,
      longPressed: false,
      pointerId: e.pointerId,
      axis: 'none',
    };
    setDragging(true);
    // Long-press → drag-режим. Армируем только там, где перенос поддержан.
    if (onDragStart) {
      clearLongPress();
      longPressTimer.current = setTimeout(() => {
        drag.current.longPressed = true;
        setDragging(false); // прекращаем визуальный свайп: жест ушёл в drag
        setDx(0);
        // Палец ещё неподвижен — самое время заблокировать нативный скролл для
        // этого касания (иначе вертикальный перенос iOS заберёт под скролл и
        // оборвёт pointercancel) и удержать события на строке через захват.
        const el = rowRef.current;
        if (el) {
          el.style.touchAction = 'none';
          try {
            el.setPointerCapture(drag.current.pointerId);
          } catch {
            /* указатель уже неактивен */
          }
        }
        // Палец, которым начат жест: без него любое чужое отпускание —
        // ладонь, второй большой палец — прилетало в общий обработчик окна и
        // коммитило перенос там, где задача в этот момент оказалась.
        onDragStart(task, {
          x: drag.current.x,
          y: drag.current.y,
          pointerId: drag.current.pointerId,
        });
      }, LONG_PRESS_MS);
      armReleaseGuard();
    }
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current.longPressed) return; // жест ведёт TasksPage
    if (e.buttons === 0) return;
    const d = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    // Любое заметное движение (по X — свайп, по Y — скролл) отменяет long-press.
    if (Math.abs(d) > DRAG_CANCEL_MOVE || Math.abs(dy) > DRAG_CANCEL_MOVE) {
      clearLongPress();
    }
    // Directional lock: пока движение мало — ничего не двигаем (убирает выезд
    // плашки от лёгкого касания). Как только ось определилась — фиксируем её:
    // вертикаль = скролл (свайп заблокирован), горизонталь = свайп действий.
    if (drag.current.axis === 'none') {
      if (Math.abs(d) < SWIPE_ACTIVATE && Math.abs(dy) < SWIPE_ACTIVATE) return;
      drag.current.axis = Math.abs(d) > Math.abs(dy) ? 'x' : 'y';
      drag.current.moved = true; // определившееся движение — это не тап
    }
    if (drag.current.axis === 'y') return; // вертикальный скролл — не свайпим
    setDx(Math.max(-ACTIONS_WIDTH, Math.min(ACTIONS_WIDTH, drag.current.dx + d)));
  };
  const onUp = () => {
    endRowDrag(); // вернуть touch-action и отпустить захват (касание завершено)
    clearLongPress();
    if (drag.current.longPressed) return; // перенос завершит TasksPage
    setDragging(false);
    // Решение принимаем снаружи setState-апдейтера: побочный эффект внутри
    // апдейтера в StrictMode вызывался бы дважды → дубль toggleTask.
    if (dx > SWIPE_THRESHOLD) {
      void handleToggle(); // свайп вправо — выполнить (handleToggle сам сбросит dx)
    } else if (dx < -SWIPE_THRESHOLD) {
      setDx(-ACTIONS_WIDTH);
    } else {
      setDx(0);
    }
  };
  const onClick = () => {
    if (drag.current.longPressed) return; // это был старт переноса, не тап
    if (drag.current.moved) return; // это был свайп, не тап
    if (dx !== 0) {
      setDx(0); // открыты действия — закрываем
      return;
    }
    onEdit?.(task);
  };

  return (
    <div className="relative -mx-4 overflow-hidden">
      {/* Действия рендерим ТОЛЬКО при свайпе влево. В покое (dx=0) красной
          кнопки нет в DOM — иначе на iOS она торчала квадратным углом за
          скругление родительской .card (translateX у строки ломает обрезку). */}
      {dx < 0 && (
        <div className="absolute inset-y-0 right-0 flex">
          <button
            type="button"
            onClick={handleTomorrow}
            className="flex w-[76px] items-center justify-center bg-surface-2 text-sm font-medium text-accent"
          >
            {t('Завтра')}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="flex w-[76px] items-center justify-center bg-danger-fill text-sm font-medium text-white"
          >
            {t('Удалить')}
          </button>
        </div>
      )}
      <div
        ref={rowRef}
        data-task-id={task.id}
        className={`relative flex touch-pan-y items-start gap-2.5 bg-surface px-4 py-2.5 ${
          draggable ? 'select-none [-webkit-user-select:none] [-webkit-touch-callout:none]' : ''
        } ${isDragSource ? 'scale-[0.97] opacity-40' : ''}`}
        style={{
          // transform только во время свайпа: translateX(0px) в покое сам по
          // себе ломал обрезку строки по скруглению .card на WebKit.
          transform: isDragSource ? undefined : dx !== 0 ? `translateX(${dx}px)` : undefined,
          transition: dragging ? 'none' : 'transform 0.2s, opacity 0.15s',
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClick={onClick}
      >
        <span className={`w-1 shrink-0 self-stretch rounded-full ${PRIORITY_BAR[task.priority]}`} />
        {overdue && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              void handleSkip();
            }}
            aria-label={t('Пропущено — не выполнено')}
            // Хит-зона перекрывается с зоной чекбокса (между ними всего 12.75px):
            // в спорной полосе выигрывает чекбокс — он ниже по DOM и он же
            // основное действие строки.
            className={`flex size-[22px] shrink-0 items-center justify-center rounded-[6px] active:scale-90 ${HIT_SLOP_44}`}
            style={{ color: 'var(--app-warning)' }}
          >
            <SkipForward size={ICON.base} />
          </button>
        )}
        <TaskCheck checked={done} onChange={handleToggle} color={project?.color} />
        <div className="min-w-0 flex-1">
          {/* text-pretty + hyphens-auto: длинные слова переносятся по слогам с
              дефисом, а не прыгают целиком на новую строку, оставляя дыры. */}
          <p
            lang="ru"
            className={`break-words text-pretty hyphens-auto font-medium ${done ? 'text-muted line-through' : ''}`}
          >
            {task.title}
          </p>
          {task.notes && (
            <p className="mt-1 whitespace-pre-line break-words border-l-2 border-hairline pl-2 font-mono text-xs leading-relaxed text-text/65">
              {task.notes}
            </p>
          )}
          {task.photos && task.photos.length > 0 && (
            <div className="mt-1.5 flex gap-1.5">
              {/* Снимок — кнопка, а не картинка. Раньше тап по нему всплывал в
                  строку и открывал форму задачи: рассмотреть фото было нельзя
                  вовсе, хотя прикрепляют его именно для этого. */}
              {task.photos.slice(0, 4).map((src, i) => (
                <button
                  key={i}
                  type="button"
                  aria-label={t('Открыть фото')}
                  onClick={(e) => {
                    e.stopPropagation();
                    // Удержание и свайп заканчиваются кликом тоже — но это не
                    // тап по фото, и просмотрщик им открывать нельзя.
                    if (drag.current.longPressed || drag.current.moved) return;
                    setViewerAt(i);
                  }}
                  className="size-12 shrink-0 overflow-hidden rounded-lg border border-hairline active:opacity-70"
                >
                  <img src={src} alt="" className="size-full object-cover" />
                </button>
              ))}
              {task.photos.length > 4 && (
                <button
                  type="button"
                  aria-label={t('Открыть фото')}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (drag.current.longPressed || drag.current.moved) return;
                    setViewerAt(4);
                  }}
                  className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-xs text-muted active:opacity-70"
                >
                  +{task.photos.length - 4}
                </button>
              )}
            </div>
          )}
          {hasMeta && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
              {frozen && (
                <span className="flex items-center gap-0.5 text-frost">
                  <Snowflake size={ICON.inline} />
                  {t('заморожено')}
                </span>
              )}
              {task.dueDate && (
                <span className={overdue ? 'text-warning' : ''}>
                  {task.startDate
                    ? formatDueRange(task.startDate, task.dueDate)
                    : formatDueDate(task.dueDate)}
                  {task.dueTime
                    ? `, ${task.dueTime}${
                        task.duration ? `–${addMinutesToTime(task.dueTime, task.duration)}` : ''
                      }`
                    : ''}
                </span>
              )}
              {task.skippedCount ? (
                <span className="text-warning">
                  {t('пропущено')}
                  {task.skippedCount > 1 ? ` ×${task.skippedCount}` : ''}
                </span>
              ) : null}
              {task.remindBefore != null && task.dueTime && (
                <span className="flex items-center" aria-label={t('Напоминание включено')}>
                  <Bell size={ICON.inline} />
                </span>
              )}
              {task.recurrence && (
                <span className="flex items-center gap-0.5">
                  <Repeat size={ICON.inline} />
                  {describeRecurrence(task.recurrence)}
                </span>
              )}
              {showProject && project && (
                <span className="truncate">
                  {project.emoji} {project.name}
                </span>
              )}
              {task.checklist.length > 0 && (
                <span className="flex items-center gap-1.5">
                  {checklistDone}/{task.checklist.length}
                  <span className="w-16">
                    <ProgressBar
                      value={checklistPct}
                      color={
                        checklistDone === task.checklist.length
                          ? 'var(--app-success)'
                          : undefined
                      }
                    />
                  </span>
                </span>
              )}
              {task.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs text-muted"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {viewerAt != null && task.photos && (
        <PhotoViewer
          photos={task.photos}
          index={viewerAt}
          onClose={() => setViewerAt(null)}
        />
      )}
    </div>
  );
}
