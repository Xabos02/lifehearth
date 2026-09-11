import { useMemo, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  FolderKanban,
} from 'lucide-react';
// Иконки разделов — из реестра, по той же причине, что и на экране поиска:
// свой список означал бы один раздел двумя разными рисунками в одном кадре.
import { SECTION_BY_ID } from '../../lib/sections';
import {
  GTrash as Trash2,
  GRepeat as RotateCcw,
} from '../../components/ui/glyphs';
import type { LucideIcon } from 'lucide-react';
import type { Table } from 'dexie';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { Button } from '../../components/ui/Button';
import { useToast } from '../../components/ui/toastContext';
import { db } from '../../db/db';
import { update } from '../../db/repo';
import { formatRu } from '../../lib/dates';
import type { BaseEntity } from '../../db/types';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

interface TrashEntry {
  table: Table<BaseEntity, string>;
  tableName: string;
  id: string;
  title: string;
  deletedAt: string;
  icon: LucideIcon;
}

export function TrashPage() {
  const toast = useToast();

  const tasks = useLiveQuery<BaseEntity[]>(() => db.tasks.toArray(), []);
  const notes = useLiveQuery<BaseEntity[]>(() => db.notes.toArray(), []);
  const goals = useLiveQuery<BaseEntity[]>(() => db.goals.toArray(), []);
  const projects = useLiveQuery<BaseEntity[]>(() => db.projects.toArray(), []);
  const learning = useLiveQuery<BaseEntity[]>(() => db.learningItems.toArray(), []);
  const expenses = useLiveQuery<BaseEntity[]>(() => db.expenseItems.toArray(), []);
  const energy = useLiveQuery<BaseEntity[]>(() => db.energyItems.toArray(), []);
  const places = useLiveQuery<BaseEntity[]>(() => db.placeItems.toArray(), []);

  const entries = useMemo<TrashEntry[]>(() => {
    const collect = (
      table: Table<BaseEntity, string>,
      tableName: string,
      icon: LucideIcon,
      rows: BaseEntity[] | undefined,
      titleOf: (row: Record<string, unknown>) => string,
    ): TrashEntry[] =>
      (rows ?? [])
        .filter((r): r is BaseEntity & { deletedAt: string } => r.deletedAt != null)
        .map((r) => ({
          table,
          tableName,
          id: r.id,
          title: titleOf(r as unknown as Record<string, unknown>),
          deletedAt: r.deletedAt,
          icon,
        }));

    const str = (v: unknown): string => (typeof v === 'string' ? v : '');

    return [
      ...collect(db.tasks, 'tasks', SECTION_BY_ID.get('tasks')!.icon, tasks, (r) => str(r.title)),
      ...collect(db.notes, 'notes', SECTION_BY_ID.get('notes')!.icon, notes, (r) => str(r.title) || t('Без названия')),
      ...collect(db.goals, 'goals', SECTION_BY_ID.get('goals')!.icon, goals, (r) => str(r.title)),
      ...collect(db.projects, 'projects', FolderKanban, projects, (r) => str(r.name)),
      ...collect(db.learningItems, 'learningItems', SECTION_BY_ID.get('learning')!.icon, learning, (r) => str(r.title)),
      ...collect(db.expenseItems, 'expenseItems', SECTION_BY_ID.get('finance')!.icon, expenses, (r) => str(r.title)),
      ...collect(db.energyItems, 'energyItems', SECTION_BY_ID.get('energy')!.icon, energy, (r) => str(r.title)),
      ...collect(db.placeItems, 'placeItems', SECTION_BY_ID.get('places')!.icon, places, (r) => str(r.title)),
    ].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }, [tasks, notes, goals, projects, learning, expenses, energy, places]);

  // Защита от повторного срабатывания, пока идёт асинхронная операция (двойной тап).
  const busyRef = useRef(false);

  async function handleRestore(entry: TrashEntry) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await update(entry.table, entry.id, { deletedAt: null });
      toast(t('Восстановлено'));
    } finally {
      busyRef.current = false;
    }
  }

  async function handlePurge(entry: TrashEntry) {
    if (busyRef.current) return;
    if (!window.confirm(t('Удалить навсегда?'))) return;
    busyRef.current = true;
    try {
      // Каскадно убираем дочерние логи и части плана, иначе они остаются
      // мусором в БД и бэкапе.
      if (entry.tableName === 'learningItems') {
        await db.learningLogs.where('itemId').equals(entry.id).delete();
        await db.learningParts.where('itemId').equals(entry.id).delete();
      }
      // Чанки файлов-вложений заметки: пока заметка лежала в корзине, они
      // оставались живыми (иначе восстановление вернуло бы её без файлов).
      if (entry.tableName === 'notes') {
        await db.noteFiles.where('noteId').equals(entry.id).delete();
      }
      // То же для файлов задачи — иначе чанки живут в базе и бэкапе вечно.
      if (entry.tableName === 'tasks') {
        await db.taskFiles.where('taskId').equals(entry.id).delete();
      }
      await db.table(entry.tableName).delete(entry.id);
      toast(t('Удалено навсегда'));
    } finally {
      busyRef.current = false;
    }
  }

  return (
    <Screen title={t('Корзина')} backTo="/more/settings">
      {entries.length === 0 ? (
        <EmptyState
          icon={Trash2}
          title={t('Корзина пуста')}
          hint={t('Удалённые записи появляются здесь и хранятся до окончательного удаления.')}
        />
      ) : (
        <div className="space-y-4">
          <div className="card p-4 text-sm leading-relaxed text-muted">
            {t('Здесь удалённые записи. Их можно восстановить или удалить навсегда.')}
          </div>
          <div className="card divide-y divide-hairline">
            {entries.map((entry) => {
              const Icon = entry.icon;
              return (
                <div key={`${entry.tableName}-${entry.id}`} className="flex items-center gap-3 px-4 py-3">
                  <Icon size={ICON.base} className="mt-0.5 shrink-0 self-start text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{entry.title || t('Без названия')}</p>
                    <p className="text-sm text-muted">
                      {t('удалено {date}', { date: formatRu(entry.deletedAt.slice(0, 10)) })}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    className="shrink-0 px-3 py-2 text-sm"
                    onClick={() => void handleRestore(entry)}
                  >
                    <span className="flex items-center gap-1.5">
                      <RotateCcw size={ICON.action} />
                      {t('Восстановить')}
                    </span>
                  </Button>
                  <button
                    aria-label={t('Удалить навсегда')}
                    className="shrink-0 p-2 text-muted active:opacity-60"
                    onClick={() => void handlePurge(entry)}
                  >
                    <Trash2 size={ICON.base} className="text-danger" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Screen>
  );
}
