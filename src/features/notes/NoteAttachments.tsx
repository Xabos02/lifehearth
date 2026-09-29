// Файлы-вложения под текстом заметки. Картинки сюда не попадают — они живут
// инлайном в самом тексте; здесь всё остальное: PDF, архивы, таблицы.

import { File as FileIcon, FileArchive, FileSpreadsheet, FileText } from 'lucide-react';
import { GClose } from '../../components/ui/glyphs';
import type { NoteAttachment } from '../../lib/noteFiles';
import { fileKindLabel, formatFileSize } from '../../lib/noteFiles';
import { t } from '../../lib/i18n';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { ICON } from '../../components/ui/icons';

/** Иконка по короткой подписи из fileKindLabel — та же раскладка, что у
 *  карточки файла в семейном чате (там она локальна для фичи, а общий дом ей
 *  выбрать негде: lib без React, а иконки — React-компоненты). */
function iconFor(kindLabel: string) {
  if (kindLabel === 'Архив') return FileArchive;
  if (kindLabel === 'Таблица') return FileSpreadsheet;
  if (kindLabel === 'Документ PDF' || kindLabel === 'Текст') return FileText;
  return FileIcon;
}

/** Скачивание по тапу: программный <a download> — как в чате. */
function download(a: NoteAttachment) {
  if (!a.data) return;
  const el = document.createElement('a');
  el.href = a.data;
  el.download = a.name;
  document.body.appendChild(el);
  el.click();
  el.remove();
}

export function NoteAttachments({
  files,
  onDelete,
}: {
  files: NoteAttachment[];
  onDelete: (fileId: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="mt-4 space-y-2" data-testid="note-attachments">
      {files.map((f) => {
        const kind = fileKindLabel(f.mime, f.name);
        const Icon = iconFor(kind);
        const ready = Boolean(f.data);
        return (
          <div key={f.fileId} className="card flex items-center gap-3 p-3">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 text-left active:opacity-60"
              onClick={() => download(f)}
              disabled={!ready}
              aria-label={t('Скачать {name}', { name: f.name })}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl tile-lh text-lh-accent">
                <Icon size={ICON.header} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-base font-medium">{f.name}</span>
                <span className="block text-xs text-lh-text-secondary">
                  {/* Чанки ещё едут синком с другого устройства — честное
                      «получение», а не карточка, притворяющаяся готовой. */}
                  {/* t(kind): fileKindLabel отдаёт русскую подпись-ключ — по ней
                      же iconFor выбирает иконку, поэтому переводим на экране. */}
                  {ready ? `${t(kind)} · ${formatFileSize(f.size)}` : t('Получение…')}
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-label={t('Удалить {name}', { name: f.name })}
              className={`shrink-0 rounded-lg p-2 text-lh-text-secondary active:bg-lh-surface-2 ${HIT_SLOP_44}`}
              onClick={() => onDelete(f.fileId)}
            >
              <GClose size={ICON.action} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
