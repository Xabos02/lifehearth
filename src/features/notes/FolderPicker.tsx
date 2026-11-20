import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react';
import { Sheet } from '../../components/ui/Sheet';
import {
  GCheck as Check,
  GNotes as NotebookText,
  GFolderPlus as FolderPlus,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { update } from '../../db/repo';
import type { NoteFolder } from '../../db/types';
import { t } from '../../lib/i18n';
import { buzz } from '../../lib/feedback';
import { ICON } from '../../components/ui/icons';
import { useToast } from '../../components/ui/toastContext';
import { useHoldToReorder } from '../tasks/useHoldToReorder';
import { flattenTree, reorderWithin } from './folderTree';

/** Шторка «Папки» — выбор того, что показывает лента заметок.
 *
 *  Папки ушли из ленты сюда (владелец, 20.11.2026: «папки сверху мешают»).
 *  Раньше список папок стоял над заметками карточкой и съедал первый экран:
 *  при четырёх папках до первой заметки надо было листать. Теперь лента
 *  начинается с заметок, а папки — за заголовком «Заметки ⌄», как альбомы в
 *  «Фото» или выбор папки в Bear/Apple Notes. Всё дерево одним списком с
 *  отступами: в любую глубину — одним касанием, без проваливания по уровням.
 *
 *  Удержание папки — перестановка внутри её уровня (та же машина, что у
 *  проектов в «Задачах»: 400 мс без движения). */
export function FolderPicker({
  open,
  folders,
  current,
  totalCount,
  countIn,
  onPick,
  onNewFolder,
  onClose,
}: {
  open: boolean;
  folders: NoteFolder[];
  current: string | null;
  totalCount: number;
  countIn: (id: string) => number;
  onPick: (id: string | null) => void;
  onNewFolder: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const flat = useMemo(() => flattenTree(folders), [folders]);
  const [dragging, setDragging] = useState<NoteFolder | null>(null);
  // Куда встанет папка: индекс в ПЛОСКОМ списке, перед которым рисуется линия
  // (flat.length — после последней строки).
  const [lineAt, setLineAt] = useState<number | null>(null);
  const insertRef = useRef<number | null>(null);

  const onReorderStart = (f: NoteFolder, at: { pointerId: number }) => {
    buzz(); // «взял» — только Android, PROTOCOL §6.4
    setDragging(f);
    const parent = f.parentId ?? null;
    const siblings = folders
      .filter((x) => (x.parentId ?? null) === parent)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const depthOf = new Map(flat.map((r) => [r.folder.id, r.depth]));
    const flatIndex = new Map(flat.map((r, i) => [r.folder.id, i]));
    // Линия «после последнего соседа» встаёт за всей его веткой, а не сразу
    // под ним: иначе она легла бы между папкой и её же подпапками.
    const afterSubtree = (id: string) => {
      let i = flatIndex.get(id)! + 1;
      const d = depthOf.get(id)!;
      while (i < flat.length && flat[i].depth > d) i++;
      return i;
    };
    const indexAt = (y: number) => {
      let idx = 0;
      for (const sib of siblings) {
        const el = document.querySelector<HTMLElement>(`[data-folder-id="${sib.id}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (y > r.top + r.height / 2) idx++;
      }
      return idx;
    };
    const toLine = (idx: number) =>
      idx < siblings.length ? flatIndex.get(siblings[idx].id)! : afterSubtree(siblings[siblings.length - 1].id);
    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== at.pointerId) return; // чужой палец не ведёт чужой жест
      e.preventDefault();
      const idx = indexAt(e.clientY);
      if (idx !== insertRef.current) {
        insertRef.current = idx;
        setLineAt(toLine(idx));
      }
    };
    const finish = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== at.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      const idx = insertRef.current;
      insertRef.current = null;
      setDragging(null);
      setLineAt(null);
      if (idx == null) return; // удержание без движения — ничего
      const changes = reorderWithin(siblings, f.id, idx);
      if (changes.length === 0) return;
      // «Положил» — только от пальца: системный обрыв жеста отклика не получает.
      if (e.type === 'pointerup') buzz();
      void (async () => {
        for (const c of changes) await update(db.noteFolders, c.id, { sortOrder: c.sortOrder });
        toast(t('Порядок папок обновлён'));
      })();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  return (
    <Sheet open={open} onClose={onClose} title={t('Папки')}>
      <div className="card divide-y divide-lh-border">
        <PickerRow
          icon={
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-lh-accent-dim text-lh-accent">
              <NotebookText size={ICON.inline} aria-hidden />
            </span>
          }
          name={t('Все заметки')}
          count={totalCount}
          active={current === null}
          onOpen={() => onPick(null)}
        />
        {flat.map(({ folder: f, depth }, i) => (
          <Fragment key={f.id}>
            {dragging && lineAt === i && <DropLine depth={depth} />}
            <FolderPickerRow
              folder={f}
              depth={depth}
              count={countIn(f.id)}
              active={current === f.id}
              dimmed={dragging?.id === f.id}
              onOpen={() => onPick(f.id)}
              onReorderStart={(at) => onReorderStart(f, at)}
            />
          </Fragment>
        ))}
        {dragging && lineAt === flat.length && <DropLine depth={0} />}
      </div>
      <button
        type="button"
        onClick={onNewFolder}
        className="mt-3 mb-2 flex min-h-12 w-full items-center justify-center gap-2 rounded-lh-btn text-base font-medium text-lh-accent active:opacity-60"
      >
        <FolderPlus size={ICON.base} aria-hidden />
        {t('Новая папка')}
      </button>
      {flat.length > 1 && (
        <p className="pb-2 text-center text-xs text-lh-text-secondary">
          {t('Удерживайте папку, чтобы поменять порядок')}
        </p>
      )}
    </Sheet>
  );
}

function DropLine({ depth }: { depth: number }) {
  return (
    <div
      className="my-0.5 h-0.5 rounded-full bg-lh-accent"
      style={{ marginLeft: 16 + depth * 20, marginRight: 16 }}
      aria-hidden
    />
  );
}

/** Строка без перестановки — «Все заметки». */
function PickerRow({
  icon,
  name,
  count,
  active,
  onOpen,
}: {
  icon: ReactNode;
  name: string;
  count: number;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? 'true' : undefined}
      className="flex min-h-14 w-full items-center gap-3 px-4 text-left active:opacity-80"
    >
      {icon}
      <span className={`min-w-0 flex-1 break-words ${active ? 'font-semibold' : ''}`}>{name}</span>
      <RowTail count={count} active={active} />
    </button>
  );
}

function RowTail({ count, active }: { count: number; active: boolean }) {
  return (
    <>
      <span className="shrink-0 text-sm tabular-nums text-lh-text-secondary">{count}</span>
      {/* Место под галочку держим всегда — иначе числа прыгали бы по столбцу. */}
      <span className="flex w-5 shrink-0 justify-end">
        {active && <Check size={ICON.inline} className="text-lh-accent" aria-hidden />}
      </span>
    </>
  );
}

function FolderPickerRow({
  folder,
  depth,
  count,
  active,
  dimmed,
  onOpen,
  onReorderStart,
}: {
  folder: NoteFolder;
  depth: number;
  count: number;
  active: boolean;
  dimmed: boolean;
  onOpen: () => void;
  onReorderStart: (at: { x: number; y: number; pointerId: number }) => void;
}) {
  const { headerProps } = useHoldToReorder(onReorderStart, onOpen);
  return (
    <button
      {...headerProps}
      // Узел строки для замера при переносе ищется по этому атрибуту.
      data-folder-id={folder.id}
      aria-current={active ? 'true' : undefined}
      className={`flex min-h-14 w-full items-center gap-3 pr-4 text-left select-none active:opacity-80 [-webkit-touch-callout:none] [-webkit-user-select:none] ${
        dimmed ? 'opacity-40' : ''
      }`}
      style={{ paddingLeft: 16 + depth * 20 }}
    >
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-[10px] text-base"
        style={{ background: `${folder.color}24` }}
        aria-hidden
      >
        {folder.emoji}
      </span>
      <span className={`min-w-0 flex-1 break-words ${active ? 'font-semibold' : ''}`}>{folder.name}</span>
      <RowTail count={count} active={active} />
    </button>
  );
}
