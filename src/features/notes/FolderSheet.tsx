import { useState } from 'react';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { db } from '../../db/db';
import { create, update, remove } from '../../db/repo';
import { PRESET_COLORS } from '../../lib/colors';
import { t } from '../../lib/i18n';
import type { NoteFolder } from '../../db/types';

// Эмодзи, а не иконки: папку человек узнаёт с одного взгляда по картинке, а не
// прочитав название. Набор небольшой и по темам, которые реально заводят —
// длинный список превращает выбор в работу.
const EMOJIS = ['📁', '💼', '🏠', '💡', '📚', '✈️', '🍽\uFE0F', '💪', '❤️', '💰', '🎯', '🎬'];

/** Создание и правка папки. Одна и та же форма: разница только в том, есть ли
 *  кнопка удаления и что написано на главной кнопке. */
export function FolderSheet({
  open,
  folder,
  parentId = null,
  onClose,
  onDeleted,
  onMove,
}: {
  open: boolean;
  folder?: NoteFolder | null;
  /** Где создать новую папку: id родителя или null для корня. Подпапка
   *  заводится из открытой папки — как в Apple Notes, без отдельного выбора
   *  расположения в форме. На правку существующей не влияет. */
  parentId?: string | null;
  onClose: () => void;
  /** Папка удалена (а не просто закрыли шит) — вызывающему экрану надо уйти
   *  с неё, остальные закрытия оставляют человека где он был. */
  onDeleted?: () => void;
  /** Человек хочет перенести папку в другое место — экран сам открывает
   *  «Куда перенести?», шит при этом закрывается. Кнопки нет, пока проп не
   *  передан или папка только создаётся: новой некуда «переезжать». */
  onMove?: (folder: NoteFolder) => void;
}) {
  const [name, setName] = useState(folder?.name ?? '');
  const [emoji, setEmoji] = useState(folder?.emoji ?? EMOJIS[0]);
  const [color, setColor] = useState(folder?.color ?? PRESET_COLORS[0]);
  const [busy, setBusy] = useState(false);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      if (folder) {
        await update(db.noteFolders, folder.id, { name: trimmed, emoji, color });
      } else {
        await create(db.noteFolders, {
          name: trimmed,
          emoji,
          color,
          sortOrder: Date.now(),
          parentId,
        });
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!folder) return;
    // Содержимое НЕ удаляем вместе с папкой — это была бы потеря данных из-за
    // действия, которое человек считает организационным. Заметки и вложенные
    // папки поднимаются на уровень выше (для корневой папки — в общий список),
    // и об этом сказано прямо в вопросе.
    if (
      !window.confirm(
        t('Удалить папку «{name}»? Содержимое останется — заметки и вложенные папки поднимутся на уровень выше.', {
          name: folder.name,
        }),
      )
    )
      return;
    const lift = folder.parentId ?? null;
    const inside = await db.notes.where('folderId').equals(folder.id).toArray();
    for (const n of inside) await update(db.notes, n.id, { folderId: lift });
    const children = await db.noteFolders.where('parentId').equals(folder.id).toArray();
    for (const c of children) {
      if (!c.deletedAt) await update(db.noteFolders, c.id, { parentId: lift });
    }
    await remove(db.noteFolders, folder.id);
    onDeleted?.();
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose} title={folder ? t('Папка') : t('Новая папка')}>
      <div className="flex flex-col gap-4 pb-2">
        <Field label={t('Название')}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('Например, «Работа»')}
            autoFocus
          />
        </Field>

        <div>
          <p className="mb-2 px-1 text-sm font-semibold text-lh-text-secondary">{t('Значок')}</p>
          <div className="grid grid-cols-6 gap-2">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                aria-label={t('Значок {e}', { e })}
                aria-pressed={emoji === e}
                onClick={() => setEmoji(e)}
                className={`flex h-11 items-center justify-center rounded-xl text-lg transition-colors ${
                  emoji === e ? 'bg-lh-accent text-lh-bg' : 'bg-lh-surface-2'
                }`}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 px-1 text-sm font-semibold text-lh-text-secondary">{t('Цвет')}</p>
          <div className="flex flex-wrap gap-2">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={t('Цвет {c}', { c })}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={`size-11 rounded-full transition-transform ${
                  color === c ? 'scale-110 ring-2 ring-lh-text-primary ring-offset-2 ring-offset-surface' : ''
                }`}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>

        <Button className="w-full" disabled={!name.trim() || busy} onClick={() => void save()}>
          {folder ? t('Сохранить') : t('Создать папку')}
        </Button>
        {folder && onMove && (
          <button
            onClick={() => onMove(folder)}
            className="w-full py-2 text-sm font-medium text-lh-accent active:opacity-60"
          >
            {t('Переместить папку')}
          </button>
        )}
        {folder && (
          <button
            onClick={() => void del()}
            className="w-full py-2 text-sm text-danger active:opacity-60"
          >
            {t('Удалить папку')}
          </button>
        )}
      </div>
    </Sheet>
  );
}
