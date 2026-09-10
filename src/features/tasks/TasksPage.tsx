import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLoaded } from '../../hooks/useLoaded';
import {
  ArrowLeft,
  ArrowRight,
  GripVertical,
  Hand,
  ListChecks,
  Repeat,
} from 'lucide-react';
import {
  GChevronDown as ChevronDown,
  GChevronRight as ChevronRight,
  GFolder as Folder,
  GPencil as Pencil,
  GPlus as Plus,
  GSun as Sun,
  GFolderPlus as FolderPlus,
  GSnowflake as Snowflake,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { isTouch } from '../../lib/platform';
import { alive, update } from '../../db/repo';
import type { Project, Task } from '../../db/types';
import { Screen } from '../../components/layout/Screen';
import { Fab } from '../../components/layout/Fab';
import { HIT_SLOP_44 } from '../../components/ui/Checkbox';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { EmptyState } from '../../components/ui/EmptyState';
import { Hint } from '../../components/ui/Hint';
import { useHint } from '../../hooks/useHint';
import { updateSettings } from '../../hooks/useSettings';
import { useToast } from '../../components/ui/toastContext';
import { t } from '../../lib/i18n';
import { formatDueDate } from '../../lib/dates';
import { describeRecurrence } from '../../lib/recurrence';
import { ProjectEditSheet } from './ProjectEditSheet';
import { QuickAddBar } from './QuickAddBar';
import { TaskEditSheet } from './TaskEditSheet';
import { TaskItem } from './TaskItem';
import { FreezeSheet } from './FreezeSheet';
import { GoalsProgress } from './GoalsProgress';
import { unfreezeAll, unfreezeTask } from './taskActions';
import { ICON, STROKE, STROKE_STRONG } from '../../components/ui/icons';
import { IconButton } from '../../components/ui/IconButton';
import { autoScrollStep } from './autoScroll';

const NONE = '__none__';
const FROZEN = '__frozen__'; // ключ свёрнутости секции «Заморожено»

// Пока палец не отошёл от точки старта дальше этого порога, жест ещё не начат
// по факту. Без него tick — он крутится каждый кадр сам по себе, независимо от
// событий движения — успевал прокрутить список и переоценить drop-зону раньше,
// чем человек вообще пошевелил пальцем: положил задачу на секцию у нижнего
// края экрана — и список уже едет, а idx уже посчитан по чужой точке.
const DRAG_START_THRESHOLD = 4;

// Переупорядочивание проектов: удержание заголовка → drag.
const LONG_PRESS_MS = 400; // удержание без движения → старт drag
// Смена уровня при переносе проекта — по СДВИГУ пальца от точки нажатия, а не
// по абсолютной координате.
//
// Абсолютный порог (было 64px от края) выглядел разумно ровно до замеров.
// Название проекта начинается примерно с 68px — значит взявший папку за имя,
// самую очевидную цель, уже стоял правее порога, и обычное переупорядочивание
// молча превращалось во вложение. А шеврон и папка ПОДпроекта лежат левее —
// и удержание за них с отпусканием НА МЕСТЕ выкидывало подпроект на верхний
// уровень, хотя человек ничего не тянул.
//
// Сдвиг от точки нажатия не зависит ни от ширины экрана, ни от того, за какое
// место схватились: не двинул по горизонтали — уровень не меняется вовсе.
// 26, а не 40. Сорок требовало дотянуться до точки, которой на экране нет:
// заголовок подпроекта начинается на x≈36, и «вынести наружу» (dx < -40) при
// хвате за шеврон означало x < 4. Симметрично ломалось вложение при хвате за
// пустое место справа от имени — кнопка заголовка тянется до карандаша, и
// уйти правее её края на 40px некуда. Двадцать шесть по-прежнему отличают
// намеренный сдвиг от дрожи пальца, но обе стороны становятся достижимы.
const NEST_DX = 26;
const DRAG_CANCEL_MOVE = 8; // сдвиг до старта = скролл, а не drag — отменяем
/** Внешний отступ между секциями-проектами (mb-12). Половина его с каждой
 *  стороны отдаётся зоне попадания соседей — иначе между папками остаётся
 *  полоса, где вложение не срабатывает вовсе. */
const SECTION_GAP = 48;

/** Поставить плашку-«призрак» под палец.
 *
 *  Вне компонента намеренно: чистая функция от узла и координаты, она ничего
 *  не замыкает. Замкни она ref с позицией — линтер React справедливо запретил
 *  бы менять этот ref дальше по коду (значение, отданное хуку, менять нельзя),
 *  а меняется он на каждом движении пальца.
 *
 *  transform, а не left/top: left/top заставляют браузер пересчитывать
 *  раскладку каждый кадр, transform уходит в композитор. */
function placeGhost(el: HTMLElement | null, x: number, y: number) {
  if (!el) return;
  el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

/** Ближайший прокручиваемый предок (overflow-y auto/scroll с переполнением). */
function getScrollParent(node: HTMLElement | null): HTMLElement | null {
  let el = node?.parentElement ?? null;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
}

/** Выкидывает из реестра секций узлы, вынутые из DOM. registerSection — ref-
 *  колбэк, и на detach (React вызывает его с el=null) он намеренно ничего не
 *  чистит: при перемонтировании новый узел с тем же ключом придёт раньше, чем
 *  успеет понадобиться старый, и ранняя чистка стирала бы его зря. Но если
 *  секцию снесли насовсем (проект удалили/свернули иерархию), запись в Map
 *  остаётся навсегда — а если она окажется ПЕРВОЙ, getScrollParent получит
 *  detached-узел, отдаст null, и авто-скролл не будет работать до перезагрузки
 *  страницы. Прогонять на каждый чих незачем: старт нового жеста — то самое
 *  место, где актуальность реестра важна, и где чистка обходится дёшево. */
function pruneDetachedSections(nodes: Map<string, HTMLElement>) {
  for (const [key, el] of nodes) {
    if (!el.isConnected) nodes.delete(key);
  }
}

/** Иконка папки проекта: стандартная 📁 заменяется папкой в цвете проекта —
 *  выбранный при создании цвет виден прямо в списке. Своё эмодзи — как есть. */
function ProjectFolderIcon({ project, size = 18 }: { project: Project; size?: number }) {
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
/** Удержание заголовка → перетаскивание секции.
 *
 *  Общая машинка для проектов и подпроектов: раньше она жила только внутри
 *  Section, из-за чего подпроект нельзя было сдвинуть вовсе. Тонкостей тут
 *  больше, чем кажется, и дублировать их вторым экземпляром — верный способ
 *  получить два разных поведения: блокировка нативного скролла ровно на время
 *  жеста, захват указателя (иначе вертикальный перенос заберёт себе iOS),
 *  отмена по сдвигу пальца (это скролл, а не удержание) и подавление клика
 *  после удачного удержания (иначе секция ещё и свернётся). */
function useHoldToReorder(
  onReorderStart: ((at: { x: number; y: number; pointerId: number }) => void) | undefined,
  onToggle: () => void,
) {
  const pressTimer = useRef<number | null>(null);
  const longFired = useRef(false);
  const startPt = useRef({ x: 0, y: 0 });
  const headerRef = useRef<HTMLButtonElement>(null);
  const pointerIdRef = useRef(0);
  const reorderable = Boolean(onReorderStart);

  // Снятие взведённого удержания живёт в ref, а не в обычной функции.
  //
  // Им же вешается и снимается сторож окна, а removeEventListener сверяет
  // функции по идентичности: пересоздай её на рендере — и сторож остался бы
  // висеть. Ref даёт один экземпляр на всё время жизни заголовка.
  /** Показать, что удержание идёт.
   *
   *  Раньше между нажатием и стартом переноса не менялось НИЧЕГО: 400 мс
   *  человек не знает, взял он папку или уже сорвал жест движением. Отсюда
   *  два одинаково плохих исхода — повести палец рано (жест отменится как
   *  скролл) или замереть с запасом и вести неуверенно. Неуверенное ведение и
   *  есть «ищу точку».
   *
   *  Сжатие вешаем на саму кнопку заголовка, а НЕ на секцию: прямоугольник
   *  секции служит зоной попадания при вложении, масштабировать его нельзя.
   *  Вибрации здесь нет намеренно — WebKit её не поддерживает, а основная
   *  платформа приложения это iPhone: сигнал обязан быть видимым. */
  const showHold = (on: boolean) => {
    const el = headerRef.current;
    if (!el) return;
    el.style.transition = on ? 'transform 400ms ease-out' : 'transform 120ms ease-out';
    el.style.transform = on ? 'scale(0.97)' : '';
  };

  const cancelRef = useRef<() => void>(() => {});
  useEffect(() => {
    cancelRef.current = () => {
      if (pressTimer.current != null) {
        clearTimeout(pressTimer.current);
        pressTimer.current = null;
      }
      // Снимаем сжатие здесь, а не в каждом обработчике: cancelPress зовётся
      // из всех трёх путей отмены и из самого таймера — иначе заголовок
      // оставался бы уменьшенным.
      const el = headerRef.current;
      if (el) {
        el.style.transition = 'transform 120ms ease-out';
        el.style.transform = '';
      }
      window.removeEventListener('pointerup', cancelRef.current);
      window.removeEventListener('pointercancel', cancelRef.current);
    };
    // Та же подстраховка, что в строке задачи: снять висящий таймер при
    // размонтировании заголовка.
    return () => cancelRef.current();
  }, []);
  const cancelPress = () => cancelRef.current();

  // Отпускание пальца ловим на ОКНЕ, а не только на самом заголовке.
  //
  // Обработчик заголовка видит отпускание, лишь когда оно пришло в него: палец
  // соскользнул на соседний элемент, строку перерисовало, экран сменился — и
  // события нет. Тогда таймер срабатывал уже после конца касания: перенос
  // стартовал без пальца, плашка приклеивалась к экрану, и убрать её было
  // нечем — pointerup больше не придёт. Окно видит отпускание всегда.
  const armReleaseGuard = () => {
    window.addEventListener('pointerup', cancelRef.current);
    window.addEventListener('pointercancel', cancelRef.current);
  };
  const endHeaderDrag = () => {
    const el = headerRef.current;
    if (!el) return;
    el.style.touchAction = '';
    try {
      el.releasePointerCapture(pointerIdRef.current);
    } catch {
      /* указатель уже отпущен */
    }
  };

  const headerProps = {
    ref: headerRef,
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (!reorderable) return;
      longFired.current = false;
      startPt.current = { x: e.clientX, y: e.clientY };
      pointerIdRef.current = e.pointerId;
      cancelPress();
      showHold(true);
      pressTimer.current = window.setTimeout(() => {
        cancelPress(); // таймер отработал: снимаем сторожа окна
        longFired.current = true;
        const el = headerRef.current;
        if (el) {
          el.style.touchAction = 'none';
          try {
            el.setPointerCapture(pointerIdRef.current);
          } catch {
            /* указатель уже неактивен */
          }
        }
        onReorderStart?.({ ...startPt.current, pointerId: pointerIdRef.current });
      }, LONG_PRESS_MS);
      armReleaseGuard();
    },
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (pressTimer.current == null) return;
      if (
        Math.abs(e.clientX - startPt.current.x) > DRAG_CANCEL_MOVE ||
        Math.abs(e.clientY - startPt.current.y) > DRAG_CANCEL_MOVE
      ) {
        cancelPress();
      }
    },
    onPointerUp: () => {
      cancelPress();
      endHeaderDrag();
    },
    onPointerCancel: () => {
      cancelPress();
      endHeaderDrag();
    },
    onClick: (e: ReactMouseEvent<HTMLButtonElement>) => {
      if (longFired.current) {
        e.preventDefault();
        longFired.current = false;
        return;
      }
      onToggle();
    },
  };
  return { reorderable, headerProps };
}

function SubSection({
  project,
  count,
  collapsed,
  onToggle,
  onEdit,
  dropRef,
  highlight = false,
  onReorderStart,
  isReorderSource = false,
  children,
}: {
  project: Project;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onEdit: () => void;
  dropRef: (el: HTMLElement | null) => void;
  highlight?: boolean;
  /** Удержание заголовка — перенести подпроект. */
  onReorderStart?: (at: { x: number; y: number; pointerId: number }) => void;
  isReorderSource?: boolean;
  children: ReactNode;
}) {
  const { reorderable, headerProps } = useHoldToReorder(onReorderStart, onToggle);
  return (
    <div
      ref={dropRef}
      data-drop-key={project.id}
      data-sub-of={project.parentId ?? ''}
      // Рельс слева красится цветом самого подпроекта, а не волосяной линией:
      // у той контраст к фону около 1.1 — она есть в разметке и отсутствует на
      // экране. Вложенность держалась на одном отступе в 20px, который ни с чем
      // на экране не совпадает, и цель для пальца была ничем не обозначена.
      style={highlight ? undefined : { borderLeftColor: project.color }}
      // Загнутые концы направляющей — РЕШЕНИЕ ВЛАДЕЛЬЦА от 10.09.2026, а не
      // недосмотр. Граница здесь только левая, радиус стоит на всех четырёх
      // углах, и браузер загибает её концы вправо; у свёрнутого подпроекта
      // высота около 44px, два радиуса по 16px съедают 32 — от полосы остаются
      // почти одни крючки. Это разбиралось: владельцу показали три варианта
      // рядом (загибы 16px, прямая вертикаль, мягкий изгиб 8px), он выбрал
      // первый. Не «чинить»: тест e2e/subproject-rail.spec.ts держит радиус.
      className={`mt-3 ml-1.5 rounded-2xl border-l-2 border-hairline pl-3 transition-[background-color,opacity] ${
        highlight ? 'border-accent bg-accent/10 ring-2 ring-accent' : ''
      } ${isReorderSource ? 'opacity-40' : ''}`}
    >
      {/* gap-3 по той же причине, что и у проекта: зона карандаша вылезает
          влево на 8.6px и при зазоре в 4px накрывала правый край заголовка. */}
      <div className="mb-1.5 flex items-center gap-3 pr-1">
        <button
          {...headerProps}
          // py-3, а не py-2.5: заголовок стал мельче кеглем, и высота зоны
          // касания просела с 44 до 42. Отступ добирает норму обратно.
          className={`flex min-w-0 flex-1 items-center gap-1.5 py-3 text-left ${
            reorderable ? 'select-none [-webkit-touch-callout:none] [-webkit-user-select:none]' : ''
          }`}
        >
          <ChevronDown
            size={ICON.action}
            className={`shrink-0 text-muted transition-transform ${collapsed ? '-rotate-90' : ''}`}
          />
          <span className="flex shrink-0 items-center">
            <ProjectFolderIcon project={project} size={ICON.action} />
          </span>
          {/* Регистром и цветом, а не жирностью. От названия задачи заголовок
              отличался ровно на одну ступень веса при том же кегле — папка
              читалась как чуть более жирная задача, а не как контейнер. Кегль
              трогать нельзя: этот заголовок ещё и ручка переноса, его высоту
              специально поднимали до нормы зоны касания. */}
          <h3 className="truncate text-sm font-semibold tracking-wide text-muted uppercase">
            {project.name}
          </h3>
          <span className="text-xs text-muted/70">{count}</span>
        </button>
        <button
          onClick={onEdit}
          aria-label={t('Редактировать подпроект')}
          className={`p-1.5 text-muted active:opacity-60 ${HIT_SLOP_44}`}
        >
          <Pencil size={ICON.inline} />
        </button>
      </div>
      {!collapsed && children}
    </div>
  );
}

/** Сворачиваемая секция с заголовком, счётчиком и (опц.) карандашом.
 *  dropRef/dropKey/highlight — для drag-and-drop: вся секция служит drop-зоной,
 *  ключ цели читается из data-drop-key узла. */
// Высота заголовков задана вертикальными отступами, а не невидимым
// расширителем зоны: рядом с заголовком стоит карандаш, и два невидимых
// прямоугольника по 44px налезли бы друг на друга — палец по заголовку
// открывал бы правку. Настоящая высота этого не допускает и заодно читается
// глазами: до сих пор строка папки была ниже строки задачи под ней.
function Section({
  title,
  icon,
  count,
  collapsed,
  onToggle,
  onEdit,
  dropRef,
  dropKey,
  highlight = false,
  onReorderStart,
  isReorderSource = false,
  children,
}: {
  title: string;
  /** Иконка перед заголовком (цветная папка проекта / эмодзи). */
  icon?: ReactNode;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onEdit?: () => void;
  dropRef?: (el: HTMLElement | null) => void;
  dropKey?: string;
  highlight?: boolean;
  /** Передаётся только реальным проектам — включает long-press переупорядочивания. */
  onReorderStart?: (at: { x: number; y: number; pointerId: number }) => void;
  /** Этот проект сейчас перетаскивают — приглушаем. */
  isReorderSource?: boolean;
  children: ReactNode;
}) {
  const { reorderable, headerProps } = useHoldToReorder(onReorderStart, onToggle);

  return (
    <section
      ref={dropRef}
      data-drop-key={dropKey}
      className={`mb-12 rounded-2xl transition-[background-color,opacity] ${
        highlight ? 'bg-accent/10 ring-2 ring-accent' : ''
      } ${isReorderSource ? 'opacity-40' : ''}`}
    >
      {/* gap-3 (12.75px). Восьми не хватило: зона касания карандаша вылезает
          на 8.6px влево, и остаток перекрытия держался на десятых долях —
          промах открывал бы редактирование проекта вместо сворачивания
          секции. Двенадцать дают честный зазор, а не ноль в пределах
          округления. Проверяется тестом перекрытия зон в e2e/touch.spec.ts. */}
      <div className="mb-2 flex items-center gap-3 px-1">
        <button
          {...headerProps}
          className={`flex flex-1 items-center gap-1.5 py-2.5 text-left ${
            reorderable ? 'select-none [-webkit-touch-callout:none] [-webkit-user-select:none]' : ''
          }`}
        >
          <ChevronDown
            size={ICON.base}
            className={`shrink-0 text-muted transition-transform ${collapsed ? '-rotate-90' : ''}`}
          />
          {icon && <span className="flex shrink-0 items-center">{icon}</span>}
          <h2 className="text-lg font-bold tracking-tight">{title}</h2>
          <span className="text-sm text-muted">{count}</span>
        </button>
        {onEdit && (
          <button
            onClick={onEdit}
            aria-label={t('Редактировать проект')}
            // Карандаш в шапке секции — 26.75px: растить его нельзя, шапка
            // потеряет плотность. Добираем до минимума 44x44 невидимой зоной —
            // у section нет overflow:hidden, а до правого края колонки 21px,
            // так что зона не срезается ни рамкой, ни overflow-x у #app-scroll.
            className={`p-1.5 text-muted active:opacity-60 ${HIT_SLOP_44}`}
          >
            <Pencil size={ICON.inline} />
          </button>
        )}
      </div>
      {!collapsed && children}
    </section>
  );
}

/** Тонкая линия-индикатор вставки задачи между строками. */
function TaskDropLine() {
  return (
    <div className="my-1.5 h-1 rounded-full bg-accent" aria-hidden />
  );
}

function TaskCard({
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
function CompletedSubsection({
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
function FrozenSection({
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
function DropLine() {
  return (
    <div className="mx-1 mb-4 flex items-center gap-2" aria-hidden>
      <span className="size-3 shrink-0 rounded-full bg-accent" />
      <span className="h-1.5 flex-1 rounded-full bg-accent" />
    </div>
  );
}

function AddTaskRow({ onClick, onAddSubproject }: { onClick: () => void; onAddSubproject?: () => void }) {
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

export function TasksPage() {
  const toast = useToast();
  // Подсказки показываем по одной: жесты — после закрытия «Быстрого добавления»,
  // иначе две обучающие карточки подряд прячут сам список задач за складкой.
  const quickAddHint = useHint('tasks-quick-add');
  const [taskSheetOpen, setTaskSheetOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [taskDefaultProject, setTaskDefaultProject] = useState<string | null>(null);
  const [projectSheetOpen, setProjectSheetOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  // Родитель по умолчанию для нового проекта («+ Подпроект» внутри секции).
  const [projectDefaultParent, setProjectDefaultParent] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [freezeSheetOpen, setFreezeSheetOpen] = useState(false);

  // --- Drag-and-drop переноса задачи между секциями-проектами ---
  // Задача, которую сейчас тащим (захвачена long-press внутри TaskItem).
  const [draggingTask, setDraggingTask] = useState<Task | null>(null);
  // Координаты пальца для «призрака» у курсора.
  // Координата пальца НЕ состояние.
  //
  // Была: setPointer на каждом pointermove, то есть до 120 раз в секунду
  // перерисовывался весь экран задач — все секции, все строки. Мемоизации в
  // разделе нет ни одной, так что перерисовывалось действительно всё. Платой
  // была та самая «неточность жеста»: плашка отставала от пальца, подсветка
  // обновлялась с задержкой, человек правил прицел по устаревшей картинке.
  //
  // Теперь положение плашки пишется прямо в узел, один раз за кадр, в том же
  // цикле кадров, который и так крутится во время переноса. Событие движения
  // больше не вызывает ни одного рендера.
  const ghostRef = useRef<HTMLDivElement>(null);
  // То же в ref — читается в RAF-цикле авто-скролла без устаревшего замыкания.
  const pointerRef = useRef({ x: 0, y: 0 });
  // Ключ секции под пальцем (projectId | NONE) — для подсветки drop-зоны.
  const [dropKey, setDropKey] = useState<string | null>(null);
  // Индекс вставки задачи внутри проекта-цели (зазор) — для линии и точного дропа.
  const [taskDropIndex, setTaskDropIndex] = useState<number | null>(null);
  const taskDropIndexRef = useRef<number | null>(null);
  // Реестр DOM-узлов секций для hit-теста по Y пальца (ключ = data-drop-key).
  const sectionNodes = useRef<Map<string, HTMLElement>>(new Map());
  // Актуальный dropKey для window-обработчика pointerup (обновляется в move).
  const dropKeyRef = useRef<string | null>(null);
  // Имена проектов по id — для тоста переноса. Синкается из projects в effect.
  const projectNamesRef = useRef<Map<string, string>>(new Map());
  // Актуальные активные задачи по проектам — для finish-обработчика drag.
  const activeByProjectRef = useRef<Map<string, Task[]>>(new Map());

  // --- Переупорядочивание проектов (long-press заголовка) ---
  // projInsertIndex — «зазор» (0..N), куда встанет проект; рисуем там линию.
  const [draggingProject, setDraggingProject] = useState<Project | null>(null);
  const [projInsertIndex, setProjInsertIndex] = useState<number | null>(null);
  // Куда упадёт перетаскиваемый проект: id родителя или null — верхний уровень.
  // Уровень задаётся ГОРИЗОНТАЛЬЮ пальца, как отступ в списке файлов: тянешь
  // влево — становится отдельным проектом, вправо — вкладывается. Определять
  // уровень по вертикали было бы гаданием: между «после проекта Бизнес» и
  // «первым подпроектом внутри Бизнеса» одна и та же точка на экране.
  const [dropParent, setDropParent] = useState<string | null>(null);
  const dropParentRef = useRef<string | null>(null);
  const projInsertRef = useRef<number | null>(null);
  // Зазор среди СВОИХ соседей — когда подпроект остаётся внутри родителя.
  // Считается отдельно от projInsertIndex: тот меряется по проектам верхнего
  // уровня, и для соседей внутри папки он ничего не значит.
  const [subInsertIndex, setSubInsertIndex] = useState<number | null>(null);
  const subInsertRef = useRef<number | null>(null);
  const projectsRef = useRef<Project[]>([]);
  const childrenRef = useRef<Map<string, Project[]>>(new Map());
  const startXRef = useRef(0);
  /** Палец, которым начат текущий перенос.
   *
   *  Слушатели живут на ОКНЕ и до сих пор принимали события от любого пальца:
   *  ладонь легла на экран во время переноса — её pointerup прилетал в finish,
   *  и задача коммитилась туда, где оказалась, хотя первый палец ещё держал.
   *  Теперь чужие события отбрасываются по этому идентификатору. */
  const activePointerRef = useRef<number | null>(null);

  const onProjectReorderStart = useCallback((p: Project, at: { x: number; y: number; pointerId: number }) => {
    // Один жест за раз. Задачу и заголовок папки можно взять двумя пальцами
    // одновременно — состояния независимы, — и тогда оба эффекта пишут
    // body.touchAction: первый снявшийся вернёт пустое значение, второй —
    // запомненное 'none', и прокрутка всего приложения умрёт до перезагрузки.
    if (activePointerRef.current !== null) return;
    activePointerRef.current = at.pointerId;
    pointerRef.current = at; // стартовая позиция пальца — «призрак» из неё, не из угла
    startXRef.current = at.x; // от неё же считается сдвиг, решающий уровень
    const idx = projectsRef.current.findIndex((x) => x.id === p.id);
    projInsertRef.current = idx;
    setProjInsertIndex(idx);
    const parent = p.parentId ?? null;
    dropParentRef.current = parent;
    setDropParent(parent);
    setDraggingProject(p);
  }, []);

  // Единственный стабильный ref-колбэк: ключ берётся из data-drop-key самого
  // узла, поэтому идентичность колбэка постоянна и React не дёргает его лишний раз.
  const registerSection = useCallback((el: HTMLElement | null) => {
    if (!el) return; // detach: чистим по значению ниже (узлы с тем же ключом перезапишутся)
    const key = el.dataset.dropKey;
    if (key) sectionNodes.current.set(key, el);
  }, []);

  // Какая секция под точкой Y. Узлы, выпавшие из DOM, отсеиваются по rect=0.
  // Подпроект вложен в секцию родителя (прямоугольники перекрываются) —
  // побеждает самый маленький (внутренний), иначе в подпроект не попасть.
  const hitTest = useCallback((y: number): string | null => {
    let best: string | null = null;
    let bestH = Infinity;
    for (const [key, el] of sectionNodes.current) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom && r.height < bestH) {
        best = key;
        bestH = r.height;
      }
    }
    return best;
  }, []);

  const onDragStart = useCallback((task: Task, at: { x: number; y: number; pointerId: number }) => {
    if (activePointerRef.current !== null) return; // один жест за раз, см. выше
    activePointerRef.current = at.pointerId;
    const key = task.projectId ?? NONE;
    dropKeyRef.current = key;
    pointerRef.current = at; // стартовая позиция пальца — иначе «призрак» из угла
    setDraggingTask(task);
    setDropKey(key);
  }, []);

  // Window-слушатели активны только во время drag. Перенос/тосты/авто-скролл — здесь.
  useEffect(() => {
    if (!draggingTask) return;
    const task = draggingTask; // фикс ссылки для замыкания finish
    // Точка, откуда стартовал жест — от неё меряем, началось ли реальное
    // движение (см. moved ниже). Копия, а не сам pointerRef: тот перезаписывается
    // в каждом move.
    const startPoint = { ...pointerRef.current };
    // Палец лёг и ещё НЕ двигался — а tick крутится каждый кадр сам по себе и
    // без этого флага уже прокручивал бы список и пересчитывал drop-зону, если
    // точка нажатия попала в краевую зону. Позиция задачи менялась бы без
    // единого движения пальцем. true выставляется в move при сдвиге > порога.
    let moved = false;

    // Реестр секций мог накопить detached-узлы (см. pruneDetachedSections) —
    // без чистки первым в Map мог оказаться именно такой, и getScrollParent
    // получил бы null.
    pruneDetachedSections(sectionNodes.current);
    // Прокручиваемый контейнер берём от любой секции (все внутри одного скролла).
    const anySection = sectionNodes.current.values().next().value ?? null;
    const scroller = getScrollParent(anySection);

    // Подсветка drop-зоны по Y пальца, без лишних setState на каждый кадр.
    const refreshDrop = (y: number) => {
      // Промах в пустоту раньше подменялся на dropKeyRef.current и шёл ДАЛЬШЕ
      // по коду — ключ замораживался, а idx всё равно пересчитывался по этому
      // старому ключу от актуального y, то есть от пустоты ниже секции: idx
      // получался равным длине списка, и задача уезжала в конец без спроса.
      // Теперь при промахе не трогаем вообще ничего — ни ключ, ни зазор,
      // остаётся последнее реальное наведение, там, где человек видел
      // подсветку. Отмена жеста не потеряна: старт ставит целью текущий
      // проект задачи, так что отпустить над своей же секцией — оставить как было.
      const hit = hitTest(y);
      if (!hit) return;
      if (hit !== dropKeyRef.current) {
        dropKeyRef.current = hit;
        setDropKey(hit);
      }
      // Зазор вставки среди отображаемых активных задач проекта-цели.
      let idx = 0;
      let seen = 0;
      const sec = sectionNodes.current.get(hit);
      const list = activeByProjectRef.current.get(hit) ?? [];
      if (sec) {
        for (const at of list) {
          const el = sec.querySelector(`[data-task-id="${at.id}"]`);
          if (!el) continue;
          seen++;
          const r = el.getBoundingClientRect();
          if (y > r.top + r.height / 2) idx++;
        }
      }
      // Свёрнутая секция-цель: узел с data-drop-key жив, но задачи не
      // отрисованы ({!collapsed && children}) — querySelector никого не
      // находит, idx остался бы 0, и задача падала бы в начало списка
      // невидимо для человека. «В конец» читается как «добавил в проект» —
      // предсказуемый результат, а не угадывание места среди того, чего не видно.
      if (seen === 0 && list.length > 0) idx = list.length;
      if (idx !== taskDropIndexRef.current) {
        taskDropIndexRef.current = idx;
        setTaskDropIndex(idx);
      }
    };

    const move = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return; // чужой палец
      e.preventDefault(); // блокируем скролл, пока тащим
      pointerRef.current = { x: e.clientX, y: e.clientY };
      if (!moved && Math.hypot(e.clientX - startPoint.x, e.clientY - startPoint.y) > DRAG_START_THRESHOLD) {
        moved = true;
      }
      refreshDrop(e.clientY);
    };

    // Авто-скролл, пока палец у края: крутим контейнер и переоцениваем drop-зону
    // даже когда палец стоит на месте (move-события при этом не приходят).
    let raf = 0;
    let last = 0; // timestamp предыдущего кадра — для шага, зависящего от времени
    const tick = (now: number) => {
      // На первом кадре last ещё не установлен — считаем dt нулевым, иначе
      // между стартом raf-цикла и первым вызовом получился бы случайный
      // скачок. last выставляется каждый кадр независимо от moved: пока
      // жест стоит на месте, время всё равно идёт, и как только палец
      // сдвинется, dt не должен внезапно оказаться огромным.
      const dt = last ? Math.min(now - last, 50) : 0;
      last = now;
      placeGhost(ghostRef.current, pointerRef.current.x, pointerRef.current.y);
      if (moved) {
        const y = pointerRef.current.y;
        if (scroller) {
          const r = scroller.getBoundingClientRect();
          // Верхние SCROLL_EDGE px геометрически лежат под липкой шапкой
          // экрана (см. Screen.tsx) — палец туда физически не попадает, и
          // без поправки разгон вверх никогда не включался бы. Меряем шапку
          // каждый кадр: дешевле, чем следить за её изменениями отдельно, а
          // устареть за один тик она не успевает.
          const header = document.querySelector('header');
          const top = Math.max(r.top, header?.getBoundingClientRect().bottom ?? r.top);
          // Шаг «за кадр» был жёстко зашит в 11px — на дисплеях с другой
          // частотой обновления (90/120Гц) авто-скролл ехал бы в 1.5-2 раза
          // быстрее того же самого замера на 60Гц. Масштабируем шаг от
          // прошедшего времени, а не от факта кадра.
          const rawStep = autoScrollStep(y, top, r.bottom);
          const step = Math.round((rawStep * dt) / (1000 / 60));
          const max = scroller.scrollHeight - scroller.clientHeight;
          const next = Math.max(0, Math.min(max, scroller.scrollTop + step));
          if (next !== scroller.scrollTop) scroller.scrollTop = next;
        }
        refreshDrop(y);
      }
      raf = requestAnimationFrame(tick);
    };

    const resetDragState = () => {
      activePointerRef.current = null;
      dropKeyRef.current = null;
      taskDropIndexRef.current = null;
      setDraggingTask(null);
      setDropKey(null);
      setTaskDropIndex(null);
    };

    const finish = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return; // чужой палец
      const target = dropKeyRef.current;
      const idx = taskDropIndexRef.current;
      // Позиция ни разу не вычислялась — значит, палец так и не сдвинулся
      // (tick заперт флагом moved) либо ни разу не оказался над секцией.
      // Раньше сюда подставлялся 0 «на всякий случай» — и неподвижное
      // удержание с отпусканием кидало задачу на ПЕРВУЮ позицию своего же
      // проекта. Жест без вычисленной позиции ничего не означает — выходим.
      if (idx === null) {
        resetDragState();
        return;
      }
      // Синк каждые 60с пишет в Dexie напрямую и мог за время жеста удалить
      // проект-цель — тогда target указывает на мёртвую запись, и без проверки
      // задача получила бы projectId, которого больше нет, и пропала бы с
      // экрана. NONE — не ссылка на проект, а «без проекта», всегда жива.
      const targetAlive = target === NONE || (target !== null && projectNamesRef.current.has(target));
      if (target && targetAlive) {
        const nextProjectId = target === NONE ? null : target;
        // Новый порядок активных задач проекта-цели с задачей на позиции idx.
        const targetTasks = activeByProjectRef.current.get(target) ?? [];
        const current = targetTasks.map((task) => task.id);
        const from = current.indexOf(task.id);
        let order: string[];
        if (from === -1) {
          order = [...current];
          order.splice(idx, 0, task.id); // из другого проекта — без сдвига
        } else {
          order = current.filter((id) => id !== task.id);
          order.splice(idx > from ? idx - 1 : idx, 0, task.id);
        }
        const changedProject = nextProjectId !== task.projectId;
        const orderChanged = changedProject || order.some((id, i) => id !== current[i]);
        // Отпустил на месте — ни проект, ни порядок не изменились. Писать в
        // Dexie тогда нечего: лишний updatedAt расходится синком на другие
        // устройства и выглядит как перестановка, которой не было.
        if (orderChanged) {
          const prevSortOrder = new Map(targetTasks.map((task) => [task.id, task.sortOrder]));
          order.forEach((id, i) => {
            const sortOrder = (i + 1) * 1000;
            if (id === task.id) {
              if (changedProject || prevSortOrder.get(id) !== sortOrder) {
                void update(db.tasks, id, { projectId: nextProjectId, sortOrder });
              }
            } else if (prevSortOrder.get(id) !== sortOrder) {
              void update(db.tasks, id, { sortOrder });
            }
          });
          if (changedProject) {
            const name =
              nextProjectId === null ? t('Без проекта') : (projectNamesRef.current.get(target) ?? t('проект'));
            toast(t('Перенесено в {name}', { name }));
          }
        }
      }
      resetDragState();
    };

    // Системный обрыв жеста (входящий звонок, шторка уведомлений) — не то же
    // самое, что отпускание пальца над целью. pointercancel сюда раньше не
    // отличался от finish и молча коммитил перенос туда, где палец случайно
    // оказался в момент прерывания.
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return; // чужой палец
      resetDragState();
    };

    // passive:false — иначе preventDefault на touch не сработает.
    const preventScroll = (ev: TouchEvent) => ev.preventDefault();
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('touchmove', preventScroll, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    // На время drag глушим скролл страницы (свой авто-скролл — программный).
    const prevTouch = document.body.style.touchAction;
    document.body.style.touchAction = 'none';
    // Цикл кадров запускается ВСЕГДА, а не только когда есть куда скроллить:
    // теперь он же двигает плашку у пальца. Раньше при коротком списке
    // (scroller === null) он не стартовал вовсе — и плашка осталась бы стоять.
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('touchmove', preventScroll);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      document.body.style.touchAction = prevTouch;
      cancelAnimationFrame(raf);
    };
  }, [draggingTask, hitTest, toast]);

  // Window-слушатели переупорядочивания проектов — активны только во время drag.
  useEffect(() => {
    if (!draggingProject) return;
    const dp = draggingProject;
    const startPoint = { ...pointerRef.current };
    // См. тот же флаг в эффекте переноса задач: без него tick крутил бы
    // список и переоценивал зазор вставки ещё до того, как палец реально
    // сдвинулся — если удержание сработало у самого края экрана.
    let moved = false;

    pruneDetachedSections(sectionNodes.current);
    const anySection = sectionNodes.current.values().next().value ?? null;
    const scroller = getScrollParent(anySection);

    // У проекта, внутри которого уже лежат подпроекты, вкладывать некуда:
    // уровней ровно два, и третий превратил бы список в дерево, по которому на
    // телефоне не попасть пальцем.
    const canNest = (childrenRef.current.get(dp.id) ?? []).length === 0;

    const refreshDrop = (x: number, y: number) => {
      // Зазор вставки = сколько проектов верхнего уровня своей серединой выше
      // пальца. Считаем по ним даже при переносе подпроекта: подпроект едет
      // «между проектами», а внутрь какого именно — решает горизонталь.
      let idx = 0;
      let hovered: string | null = null;
      for (const proj of projectsRef.current) {
        const el = sectionNodes.current.get(proj.id);
        if (!el || !el.isConnected) continue;
        const r = el.getBoundingClientRect();
        if (y > r.top + r.height / 2) idx++;
        // Зона попадания шире самой секции на половину зазора между ними.
        //
        // Между проектами стоит mb-12 — 48px, и в прямоугольник секции они не
        // входят: там hovered был null, вложение молча не срабатывало, а
        // подсказка на плашке переключалась обратно. Мёртвая полоса была шире
        // цели: у свёрнутого проекта вся секция — заголовок ~28px. Человек
        // ведёт папку к папке, на границе всё гаснет — отсюда «нужно прям
        // точку искать».
        if (proj.id !== dp.id && y >= r.top - SECTION_GAP / 2 && y <= r.bottom + SECTION_GAP / 2)
          hovered = proj.id;
      }
      // Уровень меняется только при осознанном сдвиге вбок. Вправо — внутрь
      // того, над кем стоим; влево — наружу. Между порогами уровень остаётся
      // прежним: человек просто двигает по вертикали.
      const dx = x - startXRef.current;
      const parent =
        dx > NEST_DX && canNest && hovered
          ? hovered
          : dx < -NEST_DX
            ? null
            : (dp.parentId ?? null);
      // Зазор среди соседей по папке — по их собственным секциям, а не по
      // верхнему уровню. Без него подпроект внутри родителя было НЕ переставить
      // вовсе: жест шёл, линия рисовалась, при отпускании не происходило
      // ничего.
      const was = dp.parentId ?? null;
      let subIdx = 0;
      if (was) {
        for (const sib of childrenRef.current.get(was) ?? []) {
          const el = sectionNodes.current.get(sib.id);
          if (!el || !el.isConnected) continue;
          const r = el.getBoundingClientRect();
          if (y > r.top + r.height / 2) subIdx++;
        }
      }
      if (subIdx !== subInsertRef.current) {
        subInsertRef.current = subIdx;
        setSubInsertIndex(subIdx);
      }
      if (idx !== projInsertRef.current) {
        projInsertRef.current = idx;
        setProjInsertIndex(idx);
      }
      if (parent !== dropParentRef.current) {
        dropParentRef.current = parent;
        setDropParent(parent);
      }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return; // чужой палец
      e.preventDefault();
      pointerRef.current = { x: e.clientX, y: e.clientY };
      if (!moved && Math.hypot(e.clientX - startPoint.x, e.clientY - startPoint.y) > DRAG_START_THRESHOLD) {
        moved = true;
      }
      refreshDrop(e.clientX, e.clientY);
    };
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      const dt = last ? Math.min(now - last, 50) : 0;
      last = now;
      placeGhost(ghostRef.current, pointerRef.current.x, pointerRef.current.y);
      if (moved) {
        const y = pointerRef.current.y;
        if (scroller) {
          const r = scroller.getBoundingClientRect();
          // Та же поправка на липкую шапку, что и в переносе задач — иначе
          // верхняя зона авто-скролла недостижима для пальца.
          const header = document.querySelector('header');
          const top = Math.max(r.top, header?.getBoundingClientRect().bottom ?? r.top);
          const rawStep = autoScrollStep(y, top, r.bottom);
          const step = Math.round((rawStep * dt) / (1000 / 60));
          const max = scroller.scrollHeight - scroller.clientHeight;
          const next = Math.max(0, Math.min(max, scroller.scrollTop + step));
          if (next !== scroller.scrollTop) scroller.scrollTop = next;
        }
        refreshDrop(pointerRef.current.x, y);
      }
      raf = requestAnimationFrame(tick);
    };
    const resetDragState = () => {
      activePointerRef.current = null;
      projInsertRef.current = null;
      subInsertRef.current = null;
      dropParentRef.current = null;
      setDraggingProject(null);
      setProjInsertIndex(null);
      setSubInsertIndex(null);
      setDropParent(null);
    };
    const finish = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return; // чужой палец
      const insertIndex = projInsertRef.current;
      const parent = dropParentRef.current;
      const was = dp.parentId ?? null;

      if (parent !== was) {
        // Смена уровня. Порядок внутри нового дома считаем от конца: втискивать
        // подпроект в середину чужого списка по вертикальной позиции нельзя —
        // она мерилась по проектам ВЕРХНЕГО уровня, а не по его будущим
        // соседям, и получилось бы наугад.
        const siblings = parent
          ? (childrenRef.current.get(parent) ?? [])
          : projectsRef.current;
        const last = siblings.reduce((m, x) => Math.max(m, x.sortOrder), 0);
        void update(db.projects, dp.id, { parentId: parent, sortOrder: last + 1000 });
        const name = parent
          ? projectsRef.current.find((x) => x.id === parent)?.name
          : null;
        toast(
          name
            ? t('«{project}» теперь внутри «{parent}»', { project: dp.name, parent: name })
            : t('«{project}» стал отдельным проектом', { project: dp.name }),
        );
      } else if (!was) {
        // Уровень тот же и он верхний — обычное переупорядочивание.
        const ids = projectsRef.current.map((p) => p.id);
        const from = ids.indexOf(dp.id);
        if (from !== -1 && insertIndex != null) {
          const next = ids.filter((id) => id !== dp.id);
          const insertAt = insertIndex > from ? insertIndex - 1 : insertIndex;
          next.splice(insertAt, 0, dp.id);
          if (next.some((id, i) => ids[i] !== id)) {
            next.forEach((id, i) => {
              const cur = projectsRef.current.find((p) => p.id === id);
              const order = (i + 1) * 1000;
              if (cur && cur.sortOrder !== order) void update(db.projects, id, { sortOrder: order });
            });
            toast(t('Порядок проектов обновлён'));
          }
        }
      } else {
        // Уровень тот же и он вложенный — переставляем среди СВОИХ соседей.
        // Этой ветки не было вовсе: подпроект внутри родителя проваливался
        // мимо обеих, жест выполнялся, а результата не было и объяснения тоже.
        // Порядка у подпроектов при этом не существовало в принципе: он
        // задавался моментом создания и после этого не менялся ничем.
        const sibs = childrenRef.current.get(was) ?? [];
        const ids = sibs.map((x) => x.id);
        const from = ids.indexOf(dp.id);
        const at = subInsertRef.current;
        if (from !== -1 && at != null) {
          const next = ids.filter((id) => id !== dp.id);
          next.splice(at > from ? at - 1 : at, 0, dp.id);
          if (next.some((id, i) => ids[i] !== id)) {
            next.forEach((id, i) => {
              const cur = sibs.find((x) => x.id === id);
              const order = (i + 1) * 1000;
              if (cur && cur.sortOrder !== order) void update(db.projects, id, { sortOrder: order });
            });
            toast(t('Порядок подпроектов обновлён'));
          }
        }
      }

      resetDragState();
    };
    // Системный обрыв жеста не должен коммитить перенос — см. тот же разбор
    // в эффекте переноса задач.
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return; // чужой палец
      resetDragState();
    };
    const preventScroll = (ev: TouchEvent) => ev.preventDefault();
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('touchmove', preventScroll, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    const prevTouch = document.body.style.touchAction;
    document.body.style.touchAction = 'none';
    // Цикл кадров запускается ВСЕГДА, а не только когда есть куда скроллить:
    // теперь он же двигает плашку у пальца. Раньше при коротком списке
    // (scroller === null) он не стартовал вовсе — и плашка осталась бы стоять.
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('touchmove', preventScroll);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      document.body.style.touchAction = prevTouch;
      cancelAnimationFrame(raf);
    };
  }, [draggingProject, hitTest, toast]);

  // Свёрнутые группы (проекты/«Без проекта»/«Заморожено»). По умолчанию развёрнуты.
  // Храним в settings (IndexedDB): на iOS-PWA localStorage не переживал перезапуск
  // и свёрнутость слетала. settings device-local — между устройствами не синкается.
  const settingsRow = useLiveQuery(() => db.settings.get('app'), []);
  const collapsed = useMemo(
    () => new Set(settingsRow?.collapsedProjects ?? []),
    [settingsRow?.collapsedProjects],
  );
  // Группировка временных задач. По умолчанию включена и при этом невидима:
  // пока ни одна задача не помечена временной, разделять нечего и подписи нет.
  const groupTemporary = settingsRow?.groupTemporary !== false;
  /** С какого места в списке начинаются временные — там встанет подпись. */
  const dividerOf = useCallback(
    (list: Task[]) => {
      if (!groupTemporary) return null;
      const i = list.findIndex((x) => x.temporary);
      return i >= 0 ? i : null;
    },
    [groupTemporary],
  );
  // Одноразовый перенос ранее сохранённого состояния из localStorage в settings —
  // чтобы у тех, у кого оно уцелело, свёрнутость не сбросилась при обновлении.
  const collapsedMigrated = useRef(false);
  useEffect(() => {
    if (!settingsRow || collapsedMigrated.current) return;
    collapsedMigrated.current = true;
    if (settingsRow.collapsedProjects !== undefined) return; // уже в settings
    let saved: string[] = [];
    try {
      const raw = localStorage.getItem('life-hub-collapsed-projects');
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) saved = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      /* приватный режим / повреждённое значение — стартуем с пустого */
    }
    void updateSettings({ collapsedProjects: saved });
  }, [settingsRow]);
  // Развёрнутые под-секции выполненных по ключу группы. По умолчанию — свёрнуты.
  const [expandedCompleted, setExpandedCompleted] = useState<Set<string>>(() => new Set());

  const tasksRaw = useLiveQuery(() => db.tasks.toArray(), []);
  const projectsRaw = useLiveQuery(() => db.projects.toArray(), []);

  const allTasks = alive(tasksRaw ?? []);
  // Уникальные теги из живых задач для фильтра.
  const tagOptions = useMemo(
    () => [...new Set(allTasks.flatMap((task) => task.tags))].sort((a, b) => a.localeCompare(b)),
    [allTasks],
  );
  const tasks = activeTag ? allTasks.filter((task) => task.tags.includes(activeTag)) : allTasks;
  // Проекты сверху вниз в порядке создания (sortOrder растёт → новые ниже).
  const projects = alive(projectsRaw ?? [])
    .filter((p) => !p.archivedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  // Иерархия: верхний уровень + подпроекты по родителю. Подпроект с пропавшим
  // родителем (родителя удалили/архивировали) поднимается на верхний уровень.
  const topProjects = useMemo(
    () => projects.filter((p) => !p.parentId || !projectById.has(p.parentId)),
    [projects, projectById],
  );
  // Идёт вложение, а не смена порядка: сигналы на экране должны показывать
  // одно и то же, иначе жест до самого отпускания выглядит переупорядочиванием.
  const nesting = Boolean(draggingProject) && dropParent !== (draggingProject?.parentId ?? null);
  // Линия вставки рисуется РОВНО там, где перенос и правда произойдёт.
  //
  // Раньше условием было «не вложение» — и подпроект, который остаётся внутри
  // своего родителя, получал линию между чужими папками верхнего уровня: она
  // обещала переезд, которого не будет. А при выносе наружу линии не было
  // вовсе, хотя проект действительно менял место (в конец верхнего уровня,
  // позиция при этом не выбирается — значит и обещать её нечем).
  const wasParent = draggingProject?.parentId ?? null;
  const reorderingTop = Boolean(draggingProject) && dropParent === null && wasParent === null;
  const reorderingSubs =
    Boolean(draggingProject) && dropParent !== null && dropParent === wasParent;

  const dropHint = useMemo(() => {
    if (!draggingProject) return '';
    const was = draggingProject.parentId ?? null;
    // Отказ вложить перестаёт быть немым.
    //
    // У проекта, внутри которого уже лежат подпроекты, вкладывать некуда —
    // и раньше это выглядело как непопадание: человек тянул вправо, тянул
    // сильнее, а подпись оставалась «Поменяет порядок». Отличить «я не попал»
    // от «так нельзя» было нечем, и обе жалобы владельца — «тяжело
    // прикрепить» и «нельзя подпроект в подпроект» — приходят из этого
    // одного места.
    const hasKids = projects.some((x) => x.parentId === draggingProject.id && !x.archivedAt);
    if (hasKids && dropParent === was) {
      return t('Внутри уже есть подпроекты — вложить нельзя');
    }
    // «Останется здесь» было честно, пока подпроект внутри родителя нельзя
    // было переставить вовсе. Теперь можно — и подпись обязана говорить то же,
    // что сделает отпускание, иначе это второе взаимоисключающее обещание
    // рядом с линией вставки.
    if (dropParent === was) return t('Поменяет порядок');
    if (!dropParent) return t('Станет отдельным проектом');
    const name = projects.find((x) => x.id === dropParent)?.name ?? '';
    // «в конец» — не украшение: finish кладёт проект последним в списке нового
    // родителя, позиция пальца при смене уровня не учитывается вовсе. Обещать
    // место рядом значило бы дать второе невыполнимое обещание.
    return t('Внутрь «{name}», в конец', { name });
  }, [draggingProject, dropParent, projects]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string, Project[]>();
    for (const p of projects) {
      if (!p.parentId || !projectById.has(p.parentId)) continue;
      const arr = map.get(p.parentId);
      if (arr) arr.push(p);
      else map.set(p.parentId, [p]);
    }
    return map;
  }, [projects, projectById]);

  // Синк в ref для обработчиков перетаскивания: они висят на window и читают
  // состояние в момент отпускания пальца, а не в момент подписки.
  useEffect(() => {
    projectNamesRef.current = new Map(projects.map((p) => [p.id, p.name]));
    // Вертикальный порядок считается по секциям верхнего уровня даже при
    // переносе подпроекта: он едет «между проектами», а внутрь какого именно —
    // решает горизонталь пальца.
    projectsRef.current = topProjects;
    // Дети нужны, чтобы знать, куда класть по порядку в новом родителе и
    // можно ли вкладывать вообще (у проекта с детьми — нельзя, уровней два).
    childrenRef.current = childrenByParent;
  }, [projects, topProjects, childrenByParent]);
  // «Пока нет задач» до ответа Dexie — самая заметная ложь в приложении:
  // человек с сотней задач видит её при каждом заходе. Проекты в том же
  // условии: без них список отрисовался бы без разбивки по секциям.
  // Настройки — в том же условии: пока их нет, неизвестно, собирать ли
  // временные задачи отдельно, и список отрисовался бы сгруппированным даже
  // тому, кто группировку выключил. Мелькание порядка при каждом запуске
  // выглядит как «список сам себя перекладывает».
  const loaded = useLoaded(tasksRaw, projectsRaw, settingsRow);

  const activeByProject = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      if (task.completedAt || task.frozenAt) continue; // замороженные — в отдельной секции
      const key = task.projectId ?? NONE;
      const arr = map.get(key);
      if (arr) arr.push(task);
      else map.set(key, [task]);
    }
    // Ручной порядок: по sortOrder (перетаскивание задаёт позицию). Временные
    // при включённой группировке уходят в конец — и порядок НА ЭКРАНЕ должен
    // совпасть с порядком в этом массиве: по нему считается зазор вставки при
    // переносе (refreshDrop) и по нему же раздаются sortOrder при отпускании.
    // Разойдись они — задача падала бы не туда, куда человек её вёл.
    for (const arr of map.values())
      arr.sort((a, b) =>
        groupTemporary && Boolean(a.temporary) !== Boolean(b.temporary)
          ? Number(Boolean(a.temporary)) - Number(Boolean(b.temporary))
          : a.sortOrder - b.sortOrder,
      );
    return map;
  }, [tasks, groupTemporary]);
  // Актуальные активные задачи по проектам — для finish-обработчика drag.
  useEffect(() => {
    activeByProjectRef.current = activeByProject;
  }, [activeByProject]);

  // Выполненные сгруппированы по проекту (key = projectId | NONE),
  // внутри группы — по completedAt убыв.
  const completedByProject = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.completedAt) continue;
      const key = task.projectId ?? NONE;
      const arr = map.get(key);
      if (arr) arr.push(task);
      else map.set(key, [task]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
    }
    return map;
  }, [tasks]);

  const noProjectTasks = activeByProject.get(NONE) ?? [];
  const noProjectCompleted = completedByProject.get(NONE) ?? [];

  // Замороженные задачи — отдельной секцией внизу (вне активного списка и статистики).
  const frozenTasks = useMemo(
    () =>
      tasks
        .filter((task) => task.frozenAt && !task.completedAt)
        .sort((a, b) => (b.frozenAt ?? '').localeCompare(a.frozenAt ?? '')),
    [tasks],
  );

  function toggle(id: string) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    void updateSettings({ collapsedProjects: [...next] });
  }

  function toggleCompleted(key: string) {
    setExpandedCompleted((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function openTask(task: Task | null, projectId: string | null) {
    setEditingTask(task);
    setTaskDefaultProject(projectId);
    setTaskSheetOpen(true);
  }

  function openProject(project: Project | null, defaultParentId: string | null = null) {
    setEditingProject(project);
    setProjectDefaultParent(defaultParentId);
    setProjectSheetOpen(true);
  }

  const empty = loaded && allTasks.length === 0 && projects.length === 0;

  return (
    <Screen
      title={t('Задачи')}
      right={
        // Голубой «морозный» кружок со свечением — видно, что это кнопка.
        // Метрика и зона касания 44×44 — из IconButton; здесь только заливка.
        <IconButton
          icon={Snowflake}
          label={t('Заморозить задачи')}
          onClick={() => setFreezeSheetOpen(true)}
          tone="frost"
          strokeWidth={STROKE_STRONG}
          className="bg-frost/15 shadow-[0_0_16px_-6px_var(--app-frost)] transition-transform active:scale-90"
        />
      }
    >
      <QuickAddBar />

      {/* Приближение к целям — сразу под строкой добавления. Выше неё нельзя:
          первое, зачем открывают экран задач, — записать задачу. */}
      <GoalsProgress />

      {tagOptions.length > 0 && (
        <div className="mb-4">
          <ChipRow>
            <Chip active={activeTag === null} onClick={() => setActiveTag(null)}>
              {t('Все теги')}
            </Chip>
            {tagOptions.map((tag) => (
              <Chip
                key={tag}
                active={activeTag === tag}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              >
                #{tag}
              </Chip>
            ))}
          </ChipRow>
        </div>
      )}

      {empty ? (
        <EmptyState
          icon={ListChecks}
          title={t('Пока нет задач')}
          hint={t('Нажмите «+», чтобы добавить первую задачу')}
        />
      ) : (
        <>
          {allTasks.length > 0 && !quickAddHint.visible && (
            <Hint
              id="tasks-gestures"
              title={t('Жесты списка')}
              className="mb-4"
              items={
                isTouch
                  ? [
                      { icon: ArrowRight, text: <>{t('Свайп по задаче вправо — выполнить')}</> },
                      { icon: ArrowLeft, text: <>{t('Свайп влево — «Завтра» или «Удалить»')}</> },
                      { icon: Hand, text: <>{t('Удержание задачи — перенести в другую папку')}</> },
                      { icon: GripVertical, text: <>{t('Удержание заголовка папки — перенести её; влево — вынести наружу')}</> },
                    ]
                  : [
                      { icon: ArrowRight, text: <>{t('Потяните задачу мышью вправо — выполнить')}</> },
                      { icon: ArrowLeft, text: <>{t('Влево — «Завтра» или «Удалить»')}</> },
                      { icon: Hand, text: <>{t('Зажмите задачу — перенести в другую папку')}</> },
                      { icon: GripVertical, text: <>{t('Зажмите заголовок папки — перенести; влево — вынести наружу')}</> },
                    ]
              }
            />
          )}
          {topProjects.map((p, i) => {
            const list = activeByProject.get(p.id) ?? [];
            const doneList = completedByProject.get(p.id) ?? [];
            const subs = childrenByParent.get(p.id) ?? [];
            return (
              <Fragment key={p.id}>
                {/* Линия вставки — только когда порядок и правда меняется.
                    При вложении finish кладёт проект в конец списка нового
                    родителя, insertIndex не используется вовсе, — а линия всё
                    равно рисовалась и обещала «встанет сюда». Человек видел
                    два взаимоисключающих обещания разом: линию между папками и
                    подпись «Внутрь «Здоровье»». */}
                {reorderingTop && projInsertIndex === i && <DropLine />}
                <Section
                  title={p.name}
                  icon={<ProjectFolderIcon project={p} />}
                  count={list.length}
                  collapsed={collapsed.has(p.id)}
                  onToggle={() => toggle(p.id)}
                  onEdit={() => openProject(p)}
                  dropRef={registerSection}
                  dropKey={p.id}
                  highlight={
                    (Boolean(draggingTask) && dropKey === p.id) ||
                    (nesting && dropParent === p.id)
                  }
                  onReorderStart={(at) => onProjectReorderStart(p, at)}
                  isReorderSource={draggingProject?.id === p.id}
                >
                  {/* Живые задачи ПЕРВЫМИ, выполненные — под ними.
                      
                      Было наоборот: первое, что видно под названием папки, —
                      сделанное. А рядом с ним счётчик самой папки считает
                      только активные, и в одной строке стояли два числа про
                      разное. Список открывают, чтобы увидеть, что осталось. */}
                  {list.length > 0 && (
                    <TaskCard
                      tasks={list}
                      projectById={projectById}
                      onEdit={(task) => openTask(task, task.projectId)}
                      onDragStart={onDragStart}
                      draggingId={draggingTask?.id ?? null}
                      dropIndex={draggingTask && dropKey === p.id ? taskDropIndex : null}
                      dividerAt={dividerOf(list)}
                    />
                  )}
                  {doneList.length > 0 && (
                    <CompletedSubsection
                      tasks={doneList}
                      projectById={projectById}
                      onEdit={(task) => openTask(task, task.projectId)}
                      expanded={expandedCompleted.has(p.id)}
                      onToggle={() => toggleCompleted(p.id)}
                    />
                  )}
                  <AddTaskRow
                    onClick={() => openTask(null, p.id)}
                    onAddSubproject={() => openProject(null, p.id)}
                  />
                  {subs.map((sub, si) => {
                    const subList = activeByProject.get(sub.id) ?? [];
                    const subDone = completedByProject.get(sub.id) ?? [];
                    return (
                      <Fragment key={sub.id}>
                      {reorderingSubs && dropParent === p.id && subInsertIndex === si && (
                        <DropLine />
                      )}
                      <SubSection
                        project={sub}
                        count={subList.length}
                        collapsed={collapsed.has(sub.id)}
                        onToggle={() => toggle(sub.id)}
                        onEdit={() => openProject(sub)}
                        dropRef={registerSection}
                        highlight={Boolean(draggingTask) && dropKey === sub.id}
                        onReorderStart={(at) => onProjectReorderStart(sub, at)}
                        isReorderSource={draggingProject?.id === sub.id}
                      >
                        {subList.length > 0 && (
                          <TaskCard
                            tasks={subList}
                            projectById={projectById}
                            onEdit={(task) => openTask(task, task.projectId)}
                            onDragStart={onDragStart}
                            draggingId={draggingTask?.id ?? null}
                            dropIndex={
                              draggingTask && dropKey === sub.id ? taskDropIndex : null
                            }
                            dividerAt={dividerOf(subList)}
                          />
                        )}
                        {subDone.length > 0 && (
                          <CompletedSubsection
                            tasks={subDone}
                            projectById={projectById}
                            onEdit={(task) => openTask(task, task.projectId)}
                            expanded={expandedCompleted.has(sub.id)}
                            onToggle={() => toggleCompleted(sub.id)}
                          />
                        )}
                        <AddTaskRow onClick={() => openTask(null, sub.id)} />
                      </SubSection>
                      </Fragment>
                    );
                  })}
                  {reorderingSubs && dropParent === p.id && subInsertIndex === subs.length && (
                    <DropLine />
                  )}
                </Section>
              </Fragment>
            );
          })}
          {reorderingTop && projInsertIndex === topProjects.length && <DropLine />}

          {(noProjectTasks.length > 0 || noProjectCompleted.length > 0) && (
            <Section
              title={t('Без проекта')}
              count={noProjectTasks.length}
              collapsed={collapsed.has(NONE)}
              onToggle={() => toggle(NONE)}
              dropRef={registerSection}
              dropKey={NONE}
              highlight={Boolean(draggingTask) && dropKey === NONE}
            >
              {noProjectTasks.length > 0 && (
                <TaskCard
                  tasks={noProjectTasks}
                  projectById={projectById}
                  onEdit={(task) => openTask(task, null)}
                  onDragStart={onDragStart}
                  draggingId={draggingTask?.id ?? null}
                  dropIndex={draggingTask && dropKey === NONE ? taskDropIndex : null}
                  dividerAt={dividerOf(noProjectTasks)}
                />
              )}
              {noProjectCompleted.length > 0 && (
                <CompletedSubsection
                  tasks={noProjectCompleted}
                  projectById={projectById}
                  onEdit={(task) => openTask(task, null)}
                  expanded={expandedCompleted.has(NONE)}
                  onToggle={() => toggleCompleted(NONE)}
                />
              )}
              <AddTaskRow onClick={() => openTask(null, null)} />
            </Section>
          )}

          <button
            onClick={() => openProject(null)}
            className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border py-3 text-sm font-medium text-muted active:opacity-70"
          >
            <FolderPlus size={ICON.action} /> {t('Новый проект')}
          </button>

          {frozenTasks.length > 0 && (
            <div className="mt-12">
              <FrozenSection
                tasks={frozenTasks}
                projectById={projectById}
                collapsed={collapsed.has(FROZEN)}
                onToggle={() => toggle(FROZEN)}
                onEdit={(task) => openTask(task, task.projectId)}
              />
            </div>
          )}
        </>
      )}

      <Fab onClick={() => openTask(null, null)} />

      <TaskEditSheet
        open={taskSheetOpen}
        onClose={() => setTaskSheetOpen(false)}
        task={editingTask}
        defaults={{ projectId: taskDefaultProject }}
      />
      <ProjectEditSheet
        open={projectSheetOpen}
        onClose={() => setProjectSheetOpen(false)}
        project={editingProject}
        defaults={{ parentId: projectDefaultParent }}
      />
      <FreezeSheet
        key={freezeSheetOpen ? 'freeze-open' : 'freeze-closed'}
        open={freezeSheetOpen}
        onClose={() => setFreezeSheetOpen(false)}
      />

      {/* Плашка-«призрак» у пальца. Внешний узел двигается transform'ом из
          placeGhost (без рендера), внутренний несёт смещение относительно
          пальца — иначе Tailwind-классы -translate-y-1/2 / translate-x-3 и
          позиция дрались бы за одно и то же свойство transform. */}
      {draggingTask && (
        <div
          ref={(el) => {
            // Позицию ставим в момент появления узла, до первого кадра: иначе
            // плашка мелькает из левого верхнего угла.
            ghostRef.current = el;
            placeGhost(el, pointerRef.current.x, pointerRef.current.y);
          }}
          className="pointer-events-none fixed top-0 left-0 z-[70] will-change-transform"
        >
          <div className="max-w-[70vw] -translate-y-1/2 translate-x-3 truncate rounded-xl border border-border bg-elevated px-3 py-2 text-sm font-medium opacity-90 shadow-lg shadow-black/30">
            {draggingTask.title}
          </div>
        </div>
      )}
      {draggingProject && (
        <div
          ref={(el) => {
            ghostRef.current = el;
            placeGhost(el, pointerRef.current.x, pointerRef.current.y);
          }}
          className="pointer-events-none fixed top-0 left-0 z-[70] will-change-transform"
        >
          <div className="max-w-[78vw] -translate-y-1/2 translate-x-3 rounded-xl border border-accent bg-elevated px-3 py-2 opacity-95 shadow-lg shadow-black/30">
          <span className="block truncate text-sm font-semibold">
            {draggingProject.emoji} {draggingProject.name}
          </span>
          {/* Что произойдёт при отпускании — словами, на самой плашке.
              Уровень задаётся горизонталью пальца, а горизонталь — вещь
              неочевидная: без подписи человек отпускает и узнаёт результат
              постфактум. Строка есть всегда, даже когда ничего не меняется, —
              «останется на месте» тоже ответ, и молчание вместо него читалось
              бы как «подсказка сломалась». */}
          <span className="block truncate text-xs font-medium text-accent">
            {dropHint}
          </span>
          </div>
        </div>
      )}
    </Screen>
  );
}
