import { Fragment, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLoaded } from '../../hooks/useLoaded';
import {
  FolderInput,
  Pin,
  Trash2,
} from 'lucide-react';
import {
  GSearch as Search,
  GChevronLeft as ChevronLeft,
  GCheck as Check,
  GNotes as NotebookText,
  GFolderPlus as FolderPlus,
} from '../../components/ui/glyphs';
import { useNavigate } from 'react-router';
import { Fab } from '../../components/layout/Fab';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { SearchField } from '../../components/ui/Input';
import { db } from '../../db/db';
import { alive, remove, update } from '../../db/repo';
import type { Note, NoteFolder } from '../../db/types';
import { formatRu, toKey } from '../../lib/dates';
import { t, tPlur } from '../../lib/i18n';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { FolderSheet } from './FolderSheet';
import { checklistProgress } from './checklist';
import { countNotesDeep, flattenTree, folderMoveTargets, reorderWithin } from './folderTree';
import { useHoldToReorder } from '../tasks/useHoldToReorder';
import { ICON, STROKE_STRONG } from '../../components/ui/icons';
import { useToast } from '../../components/ui/toastContext';

/** HTML заметки → плоский текст для превью/поиска (с переносами на блоках).
 *
 *  Пустой аргумент — законный случай, а не небрежность: запись может приехать
 *  синком с устройства другой версии или из восстановленной копии, где поля
 *  content не оказалось. Без этой строки первая же такая заметка роняла ВЕСЬ
 *  экран («Что-то пошло не так»), потому что рендер списка падал на
 *  undefined.replace — из-за одной битой записи человек терял доступ ко всем
 *  своим заметкам сразу. */
function htmlToText(html: string | null | undefined): string {
  const withBreaks = (html ?? '')
    .replace(/<\/?(?:div|p|li|h1|h2|ul|ol|blockquote)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  // Все HTML-сущности декодируем корректно через textarea (а не вручную).
  const ta = document.createElement('textarea');
  ta.innerHTML = withBreaks;
  return ta.value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Строка заметки со свайпом влево для удаления (pointer events — тач и мышь). */
const EMPTY_SET: ReadonlySet<string> = new Set();

/** Строка папки: тап открывает, удержание — берёт для перестановки.
 *
 *  Та же машина удержания, что у проектов в «Задачах» (400 мс без движения,
 *  сжатие как отклик). Перестановка — только внутри уровня, как в Apple
 *  Notes; «бросить папку на папку = вложить» не делаем: на тачскрине в вебе
 *  «между» и «на» ловятся плохо, а вложение уже есть через «Переместить
 *  папку» в шите. Удержание без движения ничего не меняет. */
function FolderRow({
  folder,
  count,
  onOpen,
  onReorderStart,
  dimmed,
}: {
  folder: NoteFolder;
  count: number;
  onOpen: () => void;
  onReorderStart: (at: { x: number; y: number; pointerId: number }) => void;
  dimmed: boolean;
}) {
  const { headerProps } = useHoldToReorder(onReorderStart, onOpen);
  return (
    <button
      {...headerProps}
      // Узел строки для замера при переносе ищется по этому атрибуту:
      // второй ref на кнопку не повесить — ref уже принадлежит хуку.
      data-folder-id={folder.id}
      className={`flex w-full items-center gap-3 px-4 py-3 text-left select-none active:opacity-80 [-webkit-touch-callout:none] [-webkit-user-select:none] ${
        dimmed ? 'opacity-40' : ''
      }`}
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-xl text-lg"
        style={{ background: `${folder.color}26` }}
      >
        {folder.emoji}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted">{count}</span>
    </button>
  );
}

/** Линия «встанет сюда» между строками папок. */
function FolderDropLine() {
  return <div className="mx-4 my-0.5 h-0.5 rounded-full bg-accent" aria-hidden />;
}

function NoteRow({
  note,
  onOpen,
  onDelete,
  onMoveToFolder,
  selecting = false,
  selected = false,
  onToggle,
}: {
  note: Note;
  onOpen: () => void;
  onDelete: () => void;
  /** Долгое нажатие — перенос в папку. Свайп по строке уже занят удалением, а
   *  перетаскивать строку пальцем через весь список к нужной папке на телефоне
   *  мучительно. */
  onMoveToFolder: () => void;
  /** Режим выбора нескольких: тап — отметка вместо открытия, свайп и
   *  удержание выключены, слева кружок. Как в Apple Notes после «Выбрать». */
  selecting?: boolean;
  selected?: boolean;
  onToggle?: () => void;
}) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ x: 0, dx: 0, moved: false });

  const text = useMemo(() => htmlToText(note.content), [note.content]);
  const title = note.title || text.split('\n')[0] || t('Без названия');
  const progress = useMemo(() => checklistProgress(note.content), [note.content]);
  // Первую строку текста режем, только когда она и есть заголовок (редактор
  // выводит note.title из первой строки — deriveTitle). Если контент
  // начинается с собственного текста, прежняя безусловная обрезка оставляла
  // карточку без превью вовсе.
  const lines = text.split('\n');
  const preview = (lines[0]?.trim() === title.trim() ? lines.slice(1).join(' ') : text).trim();

  const holdRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const heldRef = useRef(false);

  const cancelHold = () => {
    clearTimeout(holdRef.current);
    holdRef.current = undefined;
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (selecting) return; // в режиме выбора строка — просто кнопка-отметка
    drag.current = { x: e.clientX, dx, moved: false };
    setDragging(true);
    heldRef.current = false;
    // 500 мс — обычный порог долгого нажатия в iOS. Меньше — срабатывает при
    // обычном тапе, больше — человек успевает решить, что ничего не работает.
    holdRef.current = setTimeout(() => {
      if (drag.current.moved) return; // это свайп, а не удержание
      heldRef.current = true;
      // Отклик обязателен: без него неясно, что удержание засчиталось.
      navigator.vibrate?.(12);
      onMoveToFolder();
    }, 500);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (selecting || e.buttons === 0) return;
    const d = e.clientX - drag.current.x;
    if (Math.abs(d) > 6) {
      drag.current.moved = true;
      cancelHold(); // палец поехал — это свайп
    }
    setDx(Math.max(-88, Math.min(0, drag.current.dx + d)));
  };
  const onUp = () => {
    cancelHold();
    setDragging(false);
    setDx((cur) => (cur < -44 ? -88 : 0));
  };
  const onClick = () => {
    if (selecting) {
      onToggle?.();
      return;
    }
    if (drag.current.moved || heldRef.current) return; // свайп или удержание, не тап
    if (dx !== 0) {
      setDx(0); // открыт — закрываем
      return;
    }
    onOpen();
  };

  return (
    <div className="relative overflow-hidden rounded-2xl shadow-[var(--shadow-card)]">
      {/* Кнопку рендерим ТОЛЬКО при свайпе. В покое (dx=0) её нет в DOM —
          значит ничему просвечивать в скруглённых углах карточки (на iOS
          overflow:hidden не клипает строку с transform, и красный угол торчал
          постоянно). */}
      {dx < 0 && (
        <button
          type="button"
          onClick={onDelete}
          className="absolute inset-y-0 right-0 flex w-[88px] items-center justify-center rounded-r-[1.15rem] bg-danger-fill text-sm font-medium text-white"
        >
          {t('Удалить')}
        </button>
      )}
      <div
        // Выделение текста здесь запрещено намеренно. Строка списка — кнопка,
        // а не текст для копирования: удержание на ней открывает выбор папки,
        // и по дороге iOS успевала выделить заголовок синим и показать своё
        // меню «Скопировать / Найти». Два действия на один жест, и оба видны
        // одновременно. [-webkit-touch-callout:none] убирает системное меню,
        // select-none — саму подсветку.
        role={selecting ? 'checkbox' : undefined}
        aria-checked={selecting ? selected : undefined}
        className={`card relative flex touch-pan-y items-start gap-2 p-4 select-none [-webkit-touch-callout:none] [-webkit-user-select:none] ${
          selecting && selected ? 'ring-1 ring-accent/45' : ''
        }`}
        style={{
          // transform только во время свайпа: translateX(0px) в покое сам по
          // себе ломал обрезку по скруглению на WebKit.
          transform: dx !== 0 ? `translateX(${dx}px)` : undefined,
          transition: dragging ? 'none' : 'transform 0.2s',
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClick={onClick}
      >
        {selecting && (
          <span
            aria-hidden
            className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
              selected ? 'bg-accent-fill text-white' : 'border-2 border-muted/70'
            }`}
          >
            {selected && <Check size={ICON.inline} strokeWidth={STROKE_STRONG} />}
          </span>
        )}
        {note.pinned && <Pin size={ICON.inline} className="mt-1 shrink-0 text-accent" fill="currentColor" />}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 break-words font-semibold">{title}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
            <span className="shrink-0">{formatRu(toKey(new Date(note.updatedAt)))}</span>
            {/* У списка задач важно не начало текста, а сколько осталось —
                ради этого в него и заглядывают из общего списка. */}
            {progress ? (
              <span className="shrink-0 tabular-nums">
                {t('{done} из {total}', { done: progress.done, total: progress.total })}
              </span>
            ) : (
              preview && <span className="truncate">{preview}</span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

// Открытая папка живёт в модуле: маршрут /notes/:id размонтирует экран списка
// целиком, и state внутри компонента терял папку — возврат из заметки всегда
// выкидывал в корень (вопреки прежнему комментарию, который это обещал).
// С вложенными папками терялась бы вся глубина. Отдельный маршрут на папку —
// лишняя сущность: адрес заметки важен (шарится, восстанавливается), адрес
// папки — нет.
let lastOpenFolder: string | null = null;

export function NotesPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [query, setQuery] = useState('');
  // Открытая папка. null — корень, «Все заметки».
  const [openFolder, setOpenFolderState] = useState<string | null>(lastOpenFolder);
  const setOpenFolder = (id: string | null) => {
    lastOpenFolder = id;
    setOpenFolderState(id);
  };
  const [folderSheet, setFolderSheet] = useState<NoteFolder | 'new' | null>(null);
  // Режим переноса: выбрана заметка или папка, дальше человек тыкает в цель.
  // Один экран на обоих — «Куда перенести?» не должен выглядеть по-разному
  // в зависимости от того, что именно несут.
  const [moving, setMoving] = useState<
    | { kind: 'note'; note: Note }
    | { kind: 'notes'; ids: string[] }
    | { kind: 'folder'; folder: NoteFolder }
    | null
  >(null);
  // Режим выбора нескольких (11.09.2026, по просьбе владельца). Вход —
  // кнопкой «Выбрать» в шапке, как в Apple Notes («More → Select Notes»):
  // удержание в этом списке уже занято переносом одной заметки, и жест
  // менять нельзя. Выход — «Готово», а также сам собой при смене уровня
  // или вводе в поиск: иначе «Выбрать все» стало бы неоднозначным.
  //
  // Выбор привязан к уровню и строке поиска, на которых его включили: сменился
  // уровень или начали искать — он перестаёт быть актуальным сам, без
  // эффекта и без сброса. Набор «все» на новом экране уже другой, и держать
  // старые отметки значило бы врать.
  const selectKey = `${openFolder ?? ''}|${query}`;
  const [sel, setSel] = useState<{ key: string; ids: Set<string> } | null>(null);
  const selecting = sel !== null && sel.key === selectKey;
  const selected = selecting ? sel.ids : EMPTY_SET;
  const setSelecting = (on: boolean) => setSel(on ? { key: selectKey, ids: new Set() } : null);
  const setSelected = (upd: (prev: Set<string>) => Set<string>) =>
    setSel((prev) => (prev && prev.key === selectKey ? { key: prev.key, ids: upd(prev.ids) } : prev));
  const exitSelect = () => setSel(null);

  // Перестановка папок удержанием — внутри текущего уровня.
  const [reorderFolder, setReorderFolder] = useState<NoteFolder | null>(null);
  const [folderInsertIndex, setFolderInsertIndex] = useState<number | null>(null);
  const insertRef = useRef<number | null>(null);

  const rows = useLiveQuery(() => db.notes.toArray(), []);
  const folderRows = useLiveQuery(() => db.noteFolders.toArray(), []);
  const loaded = useLoaded(rows, folderRows);
  const allNotes = useMemo(() => alive(rows ?? []), [rows]);
  const folders = useMemo(
    () => alive(folderRows ?? []).sort((a, b) => a.sortOrder - b.sortOrder),
    [folderRows],
  );
  const current = folders.find((f) => f.id === openFolder) ?? null;
  // Запомненная папка могла исчезнуть (удалена с другого устройства, пока мы
  // были в редакторе) — тогда работаем от корня, а не от призрака: иначе
  // экран показывал бы вечное «пусто» без кнопки назад.
  const level = current ? openFolder : null;
  // Что показывать списком: в папке — её заметки, в корне — те, что НЕ
  // разложены. Иначе заметка видна и в папке, и в общем списке, и человек не
  // понимает, перенеслась она или скопировалась.
  const notes = useMemo(
    () =>
      level ? allNotes.filter((n) => n.folderId === level) : allNotes.filter((n) => !n.folderId),
    [allNotes, level],
  );
  const countIn = (id: string) => countNotesDeep(allNotes, folders, id);
  // Папки ТЕКУЩЕГО уровня: подпапки открытой папки, в корне — корневые.
  // Вложенность как в Apple Notes: каждый экран показывает один уровень.
  const levelFolders = useMemo(
    () => folders.filter((f) => (f.parentId ?? null) === level),
    [folders, level],
  );
  const parent = current ? (folders.find((f) => f.id === current.parentId) ?? null) : null;

  // Индекс поиска считаем один раз на изменение заметок, а не на каждый ввод.
  // Индекс — по ВСЕМ заметкам, а не по текущему списку: искать надо везде.
  // Результат, молча ограниченный открытой папкой, читается как «заметка
  // пропала», и это худшее, что может сделать раздел заметок.
  const index = useMemo(
    () =>
      allNotes.map((n) => ({
        note: n,
        haystack: `${n.title}\n${htmlToText(n.content)}`.toLowerCase(),
      })),
    [allNotes],
  );

  const q = query.trim().toLowerCase();
  const visibleIds = useMemo(() => new Set(notes.map((n) => n.id)), [notes]);
  const filtered = useMemo(
    () =>
      index
        .filter((x) => (q ? x.haystack.includes(q) : visibleIds.has(x.note.id)))
        .map((x) => x.note)
        .sort(
          (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
        ),
    [index, q, visibleIds],
  );

  const pinned = filtered.filter((n) => n.pinned);
  const rest = filtered.filter((n) => !n.pinned);

  const onFolderReorderStart = (f: NoteFolder, at: { pointerId: number }) => {
    setReorderFolder(f);
    const level = levelFolders;
    const indexAt = (y: number) => {
      let idx = 0;
      for (const sib of level) {
        const el = document.querySelector<HTMLElement>(`[data-folder-id="${sib.id}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (y > r.top + r.height / 2) idx++;
      }
      return idx;
    };
    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== at.pointerId) return; // чужой палец не ведёт чужой жест
      e.preventDefault();
      const idx = indexAt(e.clientY);
      if (idx !== insertRef.current) {
        insertRef.current = idx;
        setFolderInsertIndex(idx);
      }
    };
    const finish = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== at.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      const idx = insertRef.current;
      insertRef.current = null;
      setReorderFolder(null);
      setFolderInsertIndex(null);
      if (idx == null) return; // удержание без движения — ничего
      const changes = reorderWithin(level, f.id, idx);
      if (changes.length === 0) return;
      void (async () => {
        for (const c of changes) await update(db.noteFolders, c.id, { sortOrder: c.sortOrder });
        toast(t('Порядок папок обновлён'));
      })();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  function del(note: Note) {
    if (window.confirm(t('Удалить заметку?'))) void remove(db.notes, note.id);
  }

  const renderList = (items: Note[]) => (
    <div className="flex flex-col gap-2">
      {items.map((n) => (
        <NoteRow
          key={n.id}
          note={n}
          onOpen={() => navigate(`/notes/${n.id}`)}
          onDelete={() => del(n)}
          onMoveToFolder={() => setMoving({ kind: 'note', note: n })}
          selecting={selecting}
          selected={selected.has(n.id)}
          onToggle={() =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (next.has(n.id)) next.delete(n.id);
              else next.add(n.id);
              return next;
            })
          }
        />
      ))}
    </div>
  );

  /** Список заметок: сначала закреплённые, потом остальные.
   *
   *  Заголовок «Вне папок» появляется только в корне и только когда папки
   *  вообще есть, — иначе он объясняет разделение, которого человек не видит.
   *  При поиске заголовков нет вовсе: найденное лежит где угодно, и делить
   *  результат на «вне папок» и остальное значило бы врать о том, где оно. */
  const renderFound = () => (
    <>
      {pinned.length > 0 && (
        <div className="mb-4">
          <h2 className="mb-1.5 px-1 text-sm font-semibold text-muted">{t('Закреплённые')}</h2>
          {renderList(pinned)}
        </div>
      )}
      {rest.length > 0 && (
        <div className="mb-4">
          {!q && (pinned.length > 0 || levelFolders.length > 0) && (
            <h2 className="mb-1.5 px-1 text-sm font-semibold text-muted">
              {!current && levelFolders.length > 0 ? t('Вне папок') : t('Заметки')}
            </h2>
          )}
          {renderList(rest)}
        </div>
      )}
    </>
  );

  // Перенос заметки или папки. Отдельный режим, а не перетаскивание: тащить
  // строку пальцем через весь список к нужной папке на телефоне мучительно,
  // а свайп по строке уже занят удалением.
  async function moveTo(folderId: string | null) {
    if (!moving) return;
    if (moving.kind === 'note') await update(db.notes, moving.note.id, { folderId });
    else if (moving.kind === 'notes') {
      // Циклом update(), а не bulkUpdate мимо repo: repo — единственная точка
      // записи, она ставит updatedAt и будит синк; синк дебаунсится и уедет
      // одним кругом.
      for (const id of moving.ids) await update(db.notes, id, { folderId });
      toast(t('Перенесено: {n}', { n: moving.ids.length }));
      exitSelect();
    } else await update(db.noteFolders, moving.folder.id, { parentId: folderId });
    setMoving(null);
  }

  /** Удалить выбранные — мягко, в Корзину, одним подтверждением на всех. */
  async function deleteSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(t('Удалить {n}? Вернуть можно из Корзины.', { n: tPlur(ids.length, ['заметку', 'заметки', 'заметок']) }))) return;
    for (const id of ids) await remove(db.notes, id);
    toast(t('Удалено: {n}. Вернуть можно из Корзины', { n: ids.length }));
    exitSelect();
  }

  if (moving) {
    // Куда сейчас положено то, что несут, — у этой цели рисуем галочку.
    const movingParent =
      moving.kind === 'note'
        ? moving.note.folderId
        : moving.kind === 'notes'
          ? // Галочка у общей папки — только если все выбранные лежат в одной.
            (() => {
              const set = new Set(moving.ids.map((id) => allNotes.find((n) => n.id === id)?.folderId ?? null));
              return set.size === 1 ? [...set][0] : undefined;
            })()
          : (moving.folder.parentId ?? null);
    // Папку нельзя положить в себя или своего потомка — таких целей в списке
    // просто нет; для заметки годится любая папка.
    const targets =
      moving.kind === 'folder' ? folderMoveTargets(folders, moving.folder.id) : flattenTree(folders);
    return (
      <Screen title={t('Куда перенести?')} onBack={() => setMoving(null)}>
        <p className="mb-3 px-1 text-sm leading-snug text-muted">
          {moving.kind === 'note'
            ? t('Заметка «{title}» — выберите папку.', {
                title: moving.note.title || t('Без названия'),
              })
            : moving.kind === 'notes'
              ? t('{n} — выберите папку.', { n: tPlur(moving.ids.length, ['заметка', 'заметки', 'заметок']) })
              : t('Папка «{name}» — выберите, куда её вложить.', { name: moving.folder.name })}
        </p>
        <div className="card divide-y divide-hairline">
          <button
            onClick={() => void moveTo(null)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left active:opacity-80"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-lg">
              📄
            </span>
            <span className="min-w-0 flex-1 font-medium">{t('Все заметки')}</span>
            {movingParent === null && <Check size={ICON.base} className="shrink-0 text-accent" />}
          </button>
          {/* Всё дерево одним списком: вложенность показана отступом, как в
              «Куда перенести?» Apple Notes, — переносить можно на любой
              уровень, не проваливаясь по папкам. */}
          {targets.map(({ folder: f, depth }) => (
            <button
              key={f.id}
              onClick={() => void moveTo(f.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left active:opacity-80"
              style={depth > 0 ? { paddingLeft: `${16 + depth * 24}px` } : undefined}
            >
              <span
                className="flex size-9 shrink-0 items-center justify-center rounded-xl text-lg"
                style={{ background: `${f.color}26` }}
              >
                {f.emoji}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
              {movingParent === f.id && <Check size={ICON.base} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
        <button
          onClick={() => setMoving(null)}
          className="mt-4 w-full py-2 text-sm text-muted active:opacity-60"
        >
          {t('Отмена')}
        </button>
      </Screen>
    );
  }

  return (
    <Screen
      title={
        selecting
          ? t('Выбрано: {n}', { n: selected.size })
          : current
            ? `${current.emoji} ${current.name}`
            : t('Заметки')
      }
      right={
        selecting ? (
          <div className="flex items-center gap-3">
            {/* «Выбрать все» берёт заметки ТЕКУЩЕГО уровня (закреплённые и
                остальные), а не все заметки приложения: человек стоит в папке
                и ждёт, что «все» — это то, что перед ним. */}
            <button
              onClick={() =>
                setSelected(() =>
                  selected.size === filtered.length ? new Set() : new Set(filtered.map((n) => n.id)),
                )
              }
              className="text-sm font-medium text-accent active:opacity-60"
            >
              {selected.size === filtered.length && filtered.length > 0 ? t('Снять выбор') : t('Выбрать все')}
            </button>
            <button onClick={exitSelect} className="text-sm font-semibold text-accent active:opacity-60">
              {t('Готово')}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {/* «Выбрать» — вход в режим нескольких, как в Apple Notes. Есть
                только когда есть что выбирать и поле поиска пустое. */}
            {filtered.length > 0 && !q && (
              <button
                onClick={() => setSelecting(true)}
                className={`pr-1 text-sm font-medium text-accent active:opacity-60 ${HIT_SLOP_44}`}
              >
                {t('Выбрать')}
              </button>
            )}
            {/* Новая папка создаётся на ТЕКУЩЕМ уровне: в корне — корневая,
                внутри папки — вложенная, как в Apple Notes. */}
            <button
              onClick={() => setFolderSheet('new')}
              aria-label={current ? t('Новая вложенная папка') : t('Новая папка')}
              className={`p-1 text-accent active:opacity-60 ${HIT_SLOP_44}`}
            >
              <FolderPlus size={ICON.header} />
            </button>
            {current && (
              <button
                onClick={() => setFolderSheet(current)}
                className="pl-1 text-sm font-medium text-accent active:opacity-60"
              >
                {t('Изменить')}
              </button>
            )}
          </div>
        )
      }
    >
      {current && (
        <button
          onClick={() => setOpenFolder(current.parentId ?? null)}
          className="mb-3 -ml-1 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-accent active:opacity-60"
        >
          {/* Назад — на уровень выше, а не всегда в корень: внутри вложенной
              папки «Все заметки» перепрыгивал бы родителя. */}
          <ChevronLeft size={ICON.action} /> {parent ? `${parent.emoji} ${parent.name}` : t('Все заметки')}
        </button>
      )}

      <SearchField value={query} onChange={setQuery} className="mb-3" />

      {/* Папки текущего уровня — и только когда не ищут: во время поиска нужен
          результат по всем заметкам, а не разбивка по хранилищам. */}
      {!q && levelFolders.length > 0 && (
        <div className="card mb-4 divide-y divide-hairline">
          {levelFolders.map((f, i) => (
            <Fragment key={f.id}>
              {reorderFolder && folderInsertIndex === i && <FolderDropLine />}
              <FolderRow
                folder={f}
                count={countIn(f.id)}
                onOpen={() => setOpenFolder(f.id)}
                onReorderStart={(at) => onFolderReorderStart(f, at)}
                dimmed={reorderFolder?.id === f.id}
              />
            </Fragment>
          ))}
          {reorderFolder && folderInsertIndex === levelFolders.length && <FolderDropLine />}
        </div>
      )}

      {/* Поиск проверяется ПЕРВЫМ, и это не вкусовщина.
          Раньше первой стояла ветка «notes.length === 0», а notes — срез только
          текущего уровня: в корне это заметки БЕЗ папки. Стоило разложить всё
          по папкам, и корневой срез становился пуст — поиск по любому слову
          рисовал «Пока нет заметок», хотя найденное лежало в filtered (он
          считается по ВСЕМ заметкам). То же внутри пустой папки: «В папке
          пусто» вместо результата. Ровно то поведение, которое комментарий у
          индекса объявляет худшим, что может сделать раздел заметок. */}
      {q ? (
        filtered.length === 0 ? (
          <EmptyState icon={Search} title={t('Ничего не найдено')} hint={t('Попробуйте другой запрос')} />
        ) : (
          renderFound()
        )
      ) : notes.length === 0 ? (
        // Пустой уровень — это когда нет НИ заметок, НИ подпапок: экран с
        // одними папками не «пуст», и говорить так — врать о содержимом.
        loaded &&
        levelFolders.length === 0 && (
          <EmptyState
            icon={NotebookText}
            title={current ? t('В папке пусто') : t('Пока нет заметок')}
            hint={
              current
                ? t('Перенесите сюда заметку долгим нажатием на неё в общем списке')
                : t('Нажмите +, чтобы создать первую')
            }
          />
        )
      ) : (
        renderFound()
      )}

      {/* Панель действий фиксирована и накрыла бы последнюю карточку —
          распорка отдаёт ей место в конце ленты, как «+» через --fab-strip. */}
      {selecting && <div aria-hidden style={{ height: 76 }} />}
      {selecting ? (
        // Панель действий над выбранными — на месте кнопки «+»: Fab при
        // размонтировании сам отдаёт ленте полосу обратно. Неактивные при
        // пустом выборе, а не спрятанные: человек видит, что делать дальше.
        <div
          data-testid="notes-select-bar"
          // Ровно над таб-баром: у кнопки «+» клиренс 80px от низа (таб-бар и
          // 4px воздуха), панель встаёт на те же 76 без воздуха — вплотную.
          style={{ bottom: 'calc(env(safe-area-inset-bottom) + 76px)' }}
          className="fixed inset-x-0 z-30 mx-auto flex max-w-lg gap-2.5 border-t border-hairline bg-elevated px-4 py-3"
        >
          <button
            disabled={selected.size === 0}
            onClick={() => setMoving({ kind: 'notes', ids: [...selected] })}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-surface-2 py-3 text-base font-semibold disabled:opacity-40 active:opacity-80"
          >
            <FolderInput size={ICON.base} />
            {t('Переместить ({n})', { n: selected.size })}
          </button>
          <button
            disabled={selected.size === 0}
            onClick={() => void deleteSelected()}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-surface-2 py-3 text-base font-semibold text-danger disabled:opacity-40 active:opacity-80"
          >
            <Trash2 size={ICON.base} />
            {t('Удалить ({n})', { n: selected.size })}
          </button>
        </div>
      ) : (
        <Fab onClick={() => navigate(current ? `/notes/new?folder=${current.id}` : '/notes/new')} />
      )}
      <FolderSheet
        key={folderSheet === 'new' ? 'new' : (folderSheet?.id ?? 'closed')}
        open={folderSheet !== null}
        folder={folderSheet === 'new' ? null : folderSheet}
        parentId={level}
        onClose={() => setFolderSheet(null)}
        onDeleted={() => {
          // С удалённой папки уходим к её родителю — там теперь лежит её
          // содержимое. Обычное закрытие шита (правка имени) не дёргает
          // навигацию вовсе: раньше любой выход из «Изменить» выкидывал в
          // корень.
          setOpenFolder(current?.parentId ?? null);
        }}
        onMove={(f) => {
          setFolderSheet(null);
          setMoving({ kind: 'folder', folder: f });
        }}
      />
    </Screen>
  );
}
