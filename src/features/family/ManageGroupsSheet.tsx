import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { GripVertical, LogOut } from 'lucide-react';
import {
  GPencil as Pencil,
} from '../../components/ui/glyphs';
import type { FamilyConfig } from '../../db/types';
import { Sheet } from '../../components/ui/Sheet';
import { reorderFamilies } from '../../lib/family/familyState';
import { renameFamily } from '../../lib/family/familyChat';
import { leaveFamily } from '../../lib/family/familyLifecycle';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

const ROW_H = 60; // фиксированная высота строки — по ней считаем шаг перетаскивания

/** Управление семейными группами: порядок (перетаскивание за ручку),
 *  переименование (тап по названию) и выход из группы. */
export function ManageGroupsSheet({
  open,
  onClose,
  configs,
}: {
  open: boolean;
  onClose: () => void;
  configs: FamilyConfig[];
}) {
  const [order, setOrder] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const drag = useRef<{ id: string; startY: number; startIndex: number } | null>(null);

  const nameById = useMemo(
    () => Object.fromEntries(configs.map((c) => [c.familyId, c.familyName])),
    [configs],
  );

  // Синхронизируем локальный порядок при открытии и при изменении набора групп
  // (пришла/ушла группа). Во время перетаскивания порядок не трогаем.
  useEffect(() => {
    if (!open || drag.current) return;
    const ids = configs.map((c) => c.familyId);
    setOrder((prev) => {
      if (!prev.length) return ids;
      const kept = prev.filter((id) => ids.includes(id));
      const added = ids.filter((id) => !kept.includes(id));
      return [...kept, ...added];
    });
  }, [open, configs]);

  function onHandleDown(e: PointerEvent<HTMLButtonElement>, id: string) {
    if (editingId) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id, startY: e.clientY, startIndex: order.indexOf(id) };
    setDragId(id);
  }

  function onHandleMove(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    const target = Math.max(0, Math.min(order.length - 1, d.startIndex + Math.round(dy / ROW_H)));
    const cur = order.indexOf(d.id);
    if (target !== cur) {
      setOrder((o) => {
        const next = o.slice();
        next.splice(cur, 1);
        next.splice(target, 0, d.id);
        return next;
      });
    }
  }

  function onHandleUp(e: PointerEvent<HTMLButtonElement>) {
    const wasDragging = Boolean(drag.current);
    drag.current = null;
    setDragId(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* уже отпущен */
    }
    if (wasDragging) void reorderFamilies(order);
  }

  function commitRename(id: string, val: string) {
    const trimmed = val.trim();
    setEditingId(null);
    if (trimmed && trimmed !== nameById[id]) void renameFamily(id, trimmed);
  }

  async function leaveGroup(id: string, name: string) {
    const ok = window.confirm(
      t('Выйти из «{name}»? Переписка этой группы удалится с этого устройства (у остальных участников она останется).', { name }),
    );
    if (!ok) return;
    await leaveFamily(id);
    setOrder((o) => o.filter((x) => x !== id));
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('Управление группами')}>
      <div className="space-y-2 pb-2">
        <p className="px-1 text-sm text-lh-text-secondary">
          {t('Перетащите за ручку, чтобы изменить порядок. Нажмите на название — переименовать.')}
        </p>
        {order.map((id) => {
          const name = nameById[id] ?? t('Семья');
          const isDragging = dragId === id;
          return (
            <div
              key={id}
              className={`flex items-center gap-1 rounded-xl border border-lh-border bg-lh-surface px-1 transition-shadow ${
                isDragging ? 'shadow-pop' : ''
              }`}
              style={{ height: ROW_H }}
            >
              <button
                aria-label={t('Перетащить')}
                onPointerDown={(e) => onHandleDown(e, id)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                className="cursor-grab touch-none p-2 text-lh-text-secondary active:cursor-grabbing"
              >
                <GripVertical size={ICON.header} />
              </button>
              {editingId === id ? (
                <input
                  autoFocus
                  defaultValue={name}
                  onBlur={(e) => commitRename(id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-lh-accent bg-lh-surface-2 px-2.5 py-2 outline-none"
                />
              ) : (
                <button
                  onClick={() => setEditingId(id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-2 pr-1 text-left"
                >
                  <span className="truncate font-medium">{name}</span>
                  <Pencil size={ICON.inline} className="shrink-0 text-lh-text-secondary" />
                </button>
              )}
              <button
                aria-label={t('Выйти из группы')}
                onClick={() => void leaveGroup(id, name)}
                className="p-2 text-danger active:opacity-60"
              >
                <LogOut size={ICON.base} />
              </button>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
