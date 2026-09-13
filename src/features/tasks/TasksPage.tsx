import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
} from 'lucide-react';
import {
  GChevronDown as ChevronDown,
  GPencil as Pencil,
  GFolderPlus as FolderPlus,
  GPlus as Plus,
  GSnowflake as Snowflake,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { isTouch } from '../../lib/platform';
import { alive, update, updateMany } from '../../db/repo';
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
import { ProjectEditSheet } from './ProjectEditSheet';
import { QuickAddBar } from './QuickAddBar';
import { TaskEditSheet } from './TaskEditSheet';
import { FreezeSheet } from './FreezeSheet';
import { GoalsProgress } from './GoalsProgress';
import { ICON, STROKE_STRONG } from '../../components/ui/icons';
import { IconButton } from '../../components/ui/IconButton';
import { autoScrollStep } from './autoScroll';
import {
  NONE,
  FROZEN,
  DRAG_START_THRESHOLD,
  NEST_DX,
  SECTION_GAP,
  placeGhost,
  getScrollParent,
  pruneDetachedSections,
  MAX_DEPTH,
} from './dragTuning';
import { useHoldToReorder } from './useHoldToReorder';
import { nestRefusal } from './projectTree';
import {
  AddTaskRow,
  CompletedSubsection,
  DropLine,
  FrozenSection,
  ProjectFolderIcon,
  TaskCard,
} from './TaskRows';

function SubSection({
  project,
  count,
  collapsed,
  onToggle,
  onEdit,
  onAdd,
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
  /** «+» у заголовка — добавить задачу в подпроект. */
  onAdd?: () => void;
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
      // rounded-L-2xl: скругление только на ЛЕВЫХ углах — решение владельца
      // от 10.09.2026, и обе половины решения важны.
      //
      // Загнутые концы цветной полосы ему нравятся, их трогать нельзя: он
      // выбрал их из трёх показанных вариантов. А вот справа скругления
      // держать незачем — там ничего не нарисовано (замерено: границы 0px,
      // фон прозрачный), но на его экране правые углы всё равно проступали
      // еле заметными дугами и мозолили глаз. Прямые правые углы убирают их
      // независимо от того, что именно там подсвечивалось.
      //
      // Не «чинить» ни ту, ни другую половину: тест e2e/subproject-rail.spec.ts
      // держит и загибы слева, и прямые углы справа.
      className={`mt-3 ml-1.5 rounded-l-2xl border-l-2 border-hairline pl-3 transition-[background-color,opacity] ${
        highlight ? 'border-accent bg-accent/10 ring-2 ring-accent' : ''
      } ${isReorderSource ? 'opacity-40' : ''}`}
    >
      {/* gap-3 по той же причине, что и у проекта: зона карандаша вылезает
          влево на 8.6px и при зазоре в 4px накрывала правый край заголовка. */}
      <div className="mb-1.5 flex items-center gap-3 pr-1">
        <button
          {...headerProps}
          aria-expanded={!collapsed}
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
          <span
            className="project-count text-xs opacity-70"
            style={{ '--project-color': project.color } as CSSProperties}
          >
            {count}
          </span>
        </button>
        <div className="flex items-center gap-5">
          {onAdd && (
            <button
              onClick={onAdd}
              aria-label={t('Добавить задачу в подпроект')}
              className={`p-1.5 text-muted active:opacity-60 ${HIT_SLOP_44}`}
            >
              <Plus size={ICON.inline} />
            </button>
          )}
          <button
            onClick={onEdit}
            aria-label={t('Редактировать подпроект')}
            className={`p-1.5 text-muted active:opacity-60 ${HIT_SLOP_44}`}
          >
            <Pencil size={ICON.inline} />
          </button>
        </div>
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
  onAdd,
  color,
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
  /** «+» у заголовка — добавить задачу в этот проект, не листая до низа. */
  onAdd?: () => void;
  /** Цвет проекта — для счётчика (в светлой теме не применяется, см. index.css). */
  color?: string;
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
          aria-expanded={!collapsed}
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
          <span
            className="project-count text-sm"
            style={color ? ({ '--project-color': color } as CSSProperties) : undefined}
          >
            {count}
          </span>
        </button>
        {/* «+» у заголовка. Владелец: «когда много задач, мне приходится
            листать в самый низ, чтобы добавить задачу в этот проект». Стоит
            ПЕРЕД карандашом, чтобы карандаш остался у края, где к нему
            привыкли. Зазор gap-5 (20px): у обеих кнопок невидимая зона 44px
            вылезает за видимый край, и тест зон касания (e2e/touch.spec.ts)
            поймал перекрытие в 2px даже при gap-4 — палец по «+» открывал бы
            правку проекта. Двадцать дают честный запас. Нижняя «+ Задача»
            остаётся: она удобна, когда список дочитан до конца. */}
        {(onAdd || onEdit) && (
          <div className="flex items-center gap-5">
            {onAdd && (
              <button
                onClick={onAdd}
                aria-label={t('Добавить задачу в проект')}
                className={`p-1.5 text-muted active:opacity-60 ${HIT_SLOP_44}`}
              >
                <Plus size={ICON.inline} />
              </button>
            )}
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
        )}
      </div>
      {!collapsed && children}
    </section>
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
  // Над кем стоит палец при сдвиге вправо, когда вложить туда нельзя, —
  // чтобы подпись на плашке назвала причину, а не молчала «Поменяет порядок».
  const [hoveredForRefusal, setHoveredForRefusal] = useState<string | null>(null);
  const refusedRef = useRef<string | null>(null);
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
    // Ближайшие секции сверху и снизу — на случай, если палец в зазоре.
    let above: { key: string; edge: number } | null = null;
    let below: { key: string; edge: number } | null = null;
    for (const [key, el] of sectionNodes.current) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom && r.height < bestH) {
        best = key;
        bestH = r.height;
      }
      if (r.bottom < y && (!above || r.bottom > above.edge)) above = { key, edge: r.bottom };
      if (r.top > y && (!below || r.top < below.edge)) below = { key, edge: r.top };
    }
    if (best) return best;
    // Промах в зазор между папками (SECTION_GAP) — цель та, чей край ближе.
    // Свёрнутая папка — это 45px заголовка, а полосы над и под ней уходили
    // соседям: «нужно прям точку искать». Пустота над первой секцией и под
    // последней остаётся промахом — там зазора между двумя папками нет.
    if (above && below && below.edge - above.edge <= SECTION_GAP) {
      return y - above.edge <= below.edge - y ? above.key : below.key;
    }
    return null;
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
      // Пересчёт зоны — раз в кадр в tick по pointerRef: pointermove в
      // Chrome/Safari и так выровнен по кадру, а второй проход по геометрии
      // всего списка здесь удваивал цену каждого кадра переноса.
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
      // Последний pointermove мог прийти в том же кадре, что и pointerup, до
      // следующего tick — иначе «швырок с отпусканием» садился бы на позицию
      // предыдущего кадра.
      if (moved) refreshDrop(e.clientY);
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
          const writes: { id: string; changes: Partial<Task> }[] = [];
          order.forEach((id, i) => {
            const sortOrder = (i + 1) * 1000;
            if (id === task.id) {
              if (changedProject || prevSortOrder.get(id) !== sortOrder) {
                writes.push({ id, changes: { projectId: nextProjectId, sortOrder } });
              }
            } else if (prevSortOrder.get(id) !== sortOrder) {
              writes.push({ id, changes: { sortOrder } });
            }
          });
          void updateMany(db.tasks, writes);
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

    // Можно ли вложить в конкретную цель — решают правила дерева
    // (projectTree.ts): не в себя, не в потомка, и чтобы поддерево влезло в
    // три уровня. До 11.09.2026 проект с подпроектами не вкладывался никуда;
    // владелец попросил переносить его вместе с ними. Жестом цель — по-прежнему
    // проект верхнего уровня (hovered ищется среди них), третий уровень
    // достижим через форму проекта.
    const allProjects = [...projectsRef.current, ...[...childrenRef.current.values()].flat()];
    const canNestInto = (targetId: string) => nestRefusal(allProjects, dp.id, targetId) === null;

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
        dx > NEST_DX && hovered && canNestInto(hovered)
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
      const refused = dx > NEST_DX && hovered && !canNestInto(hovered) ? hovered : null;
      if (refused !== refusedRef.current) {
        refusedRef.current = refused;
        setHoveredForRefusal(refused);
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
      // Раз в кадр в tick — см. перенос задач выше.
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
      refusedRef.current = null;
      setHoveredForRefusal(null);
    };
    const finish = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return; // чужой палец
      if (moved) refreshDrop(e.clientX, e.clientY);
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
            const writes: { id: string; changes: Partial<Project> }[] = [];
            next.forEach((id, i) => {
              const cur = projectsRef.current.find((p) => p.id === id);
              const order = (i + 1) * 1000;
              if (cur && cur.sortOrder !== order) writes.push({ id, changes: { sortOrder: order } });
            });
            void updateMany(db.projects, writes);
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
            const writes: { id: string; changes: Partial<Project> }[] = [];
            next.forEach((id, i) => {
              const cur = sibs.find((x) => x.id === id);
              const order = (i + 1) * 1000;
              if (cur && cur.sortOrder !== order) writes.push({ id, changes: { sortOrder: order } });
            });
            void updateMany(db.projects, writes);
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

  // Задача из строки быстрого ввода ложится в конец «Без проекта» — ниже
  // всех папок. Человек жал Enter, поле очищалось, а задачи на экране не было.
  // Строка появляется в DOM следующим рендером после ответа liveQuery — ждём
  // её по кадрам и докручиваем ленту. Не scrollIntoView: он крутит всех
  // предков и на iOS устраивал «войну скроллов» (см. ChatTab).
  const revealTask = useCallback((id: string) => {
    let tries = 0;
    const attempt = () => {
      const el = document.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
      if (!el) {
        if (tries++ < 60) requestAnimationFrame(attempt);
        return;
      }
      const sc = document.getElementById('app-scroll');
      if (!sc) return;
      const r = el.getBoundingClientRect();
      const cr = sc.getBoundingClientRect();
      if (r.bottom > cr.bottom) sc.scrollTop += r.bottom - cr.bottom + 16;
      else if (r.top < cr.top) sc.scrollTop -= cr.top - r.top + 16;
    };
    requestAnimationFrame(attempt);
  }, []);

  // Живые списки — в useMemo по СЫРОМУ ответу базы. useLiveQuery отдаёт одну и
  // ту же ссылку, пока запрос не эмитит заново; alive() же строил новый
  // массив на каждый рендер, и вся цепочка useMemo ниже (группировка по
  // проектам, дети, выполненные, заморозка) пересчитывалась при каждом
  // движении линии вставки, сворачивании папки, открытии шторки — при том,
  // что данные не менялись. Разбор 08.09, подтверждён 12.09.
  const allTasks = useMemo(() => alive(tasksRaw ?? []), [tasksRaw]);
  // Уникальные теги из живых задач для фильтра.
  const tagOptions = useMemo(
    () => [...new Set(allTasks.flatMap((task) => task.tags))].sort((a, b) => a.localeCompare(b)),
    [allTasks],
  );
  const tasks = useMemo(
    () => (activeTag ? allTasks.filter((task) => task.tags.includes(activeTag)) : allTasks),
    [allTasks, activeTag],
  );
  // Проекты сверху вниз в порядке создания (sortOrder растёт → новые ниже).
  const projects = useMemo(
    () =>
      alive(projectsRaw ?? [])
        .filter((p) => !p.archivedAt)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [projectsRaw],
  );

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
    // Отказ вложить — с причиной. hoveredRef хранит, над кем стоит палец при
    // сдвиге вправо; если туда нельзя, dropParent остался прежним, и надо
    // объяснить почему, а не молчать «Поменяет порядок».
    if (dropParent === was && hoveredForRefusal) {
      const why = nestRefusal(projects, draggingProject.id, hoveredForRefusal);
      if (why === 'depth') return t('Глубже трёх уровней не поместится');
      if (why === 'cycle') return t('Нельзя вложить проект в его же подпроект');
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
  }, [draggingProject, dropParent, projects, hoveredForRefusal]);

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
  // Один стабильный обработчик на все строки: с инлайн-стрелкой memo у
  // TaskItem не работал бы — новая функция каждый рендер.
  const editTask = useCallback((task: Task) => {
    setEditingTask(task);
    setTaskDefaultProject(task.projectId);
    setTaskSheetOpen(true);
  }, []);

  function openProject(project: Project | null, defaultParentId: string | null = null) {
    setEditingProject(project);
    setProjectDefaultParent(defaultParentId);
    setProjectSheetOpen(true);
  }

  const empty = loaded && allTasks.length === 0 && projects.length === 0;


  /** Подпроекты родителя, рекурсивно до MAX_DEPTH.
   *
   *  До 11.09.2026 разметка знала ровно два уровня: topProjects.map, а в
   *  нём subs.map — третьего физически не существовало. Владелец попросил
   *  прикреплять проект вместе с его подпроектами к другому проекту; после
   *  такого переноса появляется третий уровень, и без рекурсии он просто
   *  не отрисовывался бы. Глубина ограничена MAX_DEPTH: глубже телефон не
   *  вмещает. */
  const renderSubtree = (parent: Project, depth: number): ReactNode => {
    if (depth >= MAX_DEPTH + 1) return null;
    const subs = childrenByParent.get(parent.id) ?? [];
    return (
      <>
        {subs.map((sub, si) => {
          const subList = activeByProject.get(sub.id) ?? [];
          const subDone = completedByProject.get(sub.id) ?? [];
          return (
            <Fragment key={sub.id}>
              {reorderingSubs && dropParent === parent.id && subInsertIndex === si && <DropLine />}
              <SubSection
                project={sub}
                count={subList.length}
                collapsed={collapsed.has(sub.id)}
                onToggle={() => toggle(sub.id)}
                onEdit={() => openProject(sub)}
                onAdd={() => openTask(null, sub.id)}
                dropRef={registerSection}
                highlight={Boolean(draggingTask) && dropKey === sub.id}
                onReorderStart={(at) => onProjectReorderStart(sub, at)}
                isReorderSource={draggingProject?.id === sub.id}
              >
                {subList.length > 0 && (
                  <TaskCard
                    tasks={subList}
                    projectById={projectById}
                    onEdit={editTask}
                    onDragStart={onDragStart}
                    draggingId={draggingTask?.id ?? null}
                    dropIndex={draggingTask && dropKey === sub.id ? taskDropIndex : null}
                    dividerAt={dividerOf(subList)}
                  />
                )}
                {subDone.length > 0 && (
                  <CompletedSubsection
                    tasks={subDone}
                    projectById={projectById}
                    onEdit={editTask}
                    expanded={expandedCompleted.has(sub.id)}
                    onToggle={() => toggleCompleted(sub.id)}
                  />
                )}
                <AddTaskRow
                  onClick={() => openTask(null, sub.id)}
                  onAddSubproject={depth < MAX_DEPTH - 1 ? () => openProject(null, sub.id) : undefined}
                />
                {renderSubtree(sub, depth + 1)}
              </SubSection>
            </Fragment>
          );
        })}
        {reorderingSubs && dropParent === parent.id && subInsertIndex === subs.length && <DropLine />}
      </>
    );
  };

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
      <QuickAddBar onCreated={revealTask} />

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
                      { icon: GripVertical, text: <>{t('Удержание заголовка папки — перенести её; вправо — вложить в другую, влево — вынести наружу')}</> },
                    ]
                  : [
                      { icon: ArrowRight, text: <>{t('Потяните задачу мышью вправо — выполнить')}</> },
                      { icon: ArrowLeft, text: <>{t('Влево — «Завтра» или «Удалить»')}</> },
                      { icon: Hand, text: <>{t('Зажмите задачу — перенести в другую папку')}</> },
                      { icon: GripVertical, text: <>{t('Зажмите заголовок папки — перенести; вправо — вложить в другую, влево — вынести наружу')}</> },
                    ]
              }
            />
          )}
          {topProjects.map((p, i) => {
            const list = activeByProject.get(p.id) ?? [];
            const doneList = completedByProject.get(p.id) ?? [];
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
                  onAdd={() => openTask(null, p.id)}
                  color={p.color}
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
                      onEdit={editTask}
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
                      onEdit={editTask}
                      expanded={expandedCompleted.has(p.id)}
                      onToggle={() => toggleCompleted(p.id)}
                    />
                  )}
                  <AddTaskRow
                    onClick={() => openTask(null, p.id)}
                    onAddSubproject={() => openProject(null, p.id)}
                  />
                  {renderSubtree(p, 1)}
                </Section>
              </Fragment>
            );
          })}
          {reorderingTop && projInsertIndex === topProjects.length && <DropLine />}

          {/* Пустая «Без проекта» появляется на время переноса задачи из
              папки: иначе вынести задачу из проекта было некуда — цель
              исчезала вместе с последней задачей. */}
          {(noProjectTasks.length > 0 ||
            noProjectCompleted.length > 0 ||
            (draggingTask !== null && draggingTask.projectId !== null)) && (
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
                  onEdit={editTask}
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
                  onEdit={editTask}
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
                onEdit={editTask}
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
