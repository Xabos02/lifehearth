// Файлы-вложения задач: нарезка при сохранении и сборка при чтении.
//
// Тот же механизм, что у заметок (noteFiles.ts) и семейного чата
// (family/fileTransfer.ts): строковые срезы dataURL по 400 КБ сырых байт,
// сборка конкатенацией, терпимость к дублям и произвольному порядку. Разница
// только в таблице и ключе владельца — taskId вместо noteId.
//
// Появилось 11.09.2026: владелец попросил прикреплять к задаче «файлы любых
// форматов и по максимуму объём». Предел — те же 8 МиБ, что у заметок и чата:
// один лимит на всё приложение проще объяснить и проще держать; чанк в 400 КБ
// с запасом влезает в потолок записи синхронизации (1,6 МБ).

import type { TaskFile } from '../db/types';
import {
  MAX_FILE_BYTES,
  assembleFile,
  fileKindLabel,
  formatFileSize,
  splitDataUrl,
} from './family/fileTransfer';

export { MAX_FILE_BYTES, fileKindLabel, formatFileSize };

/** Вложение глазами UI: метаданные + содержимое, когда все чанки на месте. */
export interface TaskAttachment {
  fileId: string;
  name: string;
  mime: string;
  size: number;
  /** dataURL целиком; undefined — часть чанков ещё не доехала синком. */
  data?: string;
}

/** Заготовки чанк-записей для create(): без id и штампов — их ставит repo. */
export function planTaskFileChunks(
  taskId: string,
  fileId: string,
  meta: { name: string; mime: string; size: number },
  dataUrl: string,
): Array<Omit<TaskFile, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>> {
  const pieces = splitDataUrl(dataUrl);
  return pieces.map((data, idx) => ({
    taskId,
    fileId,
    idx,
    total: pieces.length,
    name: meta.name,
    mime: meta.mime,
    size: meta.size,
    data,
  }));
}

/** Собирает вложения задачи из её чанков. Порядок — по имени, затем по
 *  fileId: стабильный от перезагрузки к перезагрузке. Неполное вложение
 *  (часть чанков ещё едет синком) возвращается без data — карточка честно
 *  покажет «получение», а не битый файл. */
export function groupTaskAttachments(rows: TaskFile[]): TaskAttachment[] {
  const byFile = new Map<string, TaskFile[]>();
  for (const r of rows) {
    if (r.deletedAt) continue;
    const list = byFile.get(r.fileId);
    if (list) list.push(r);
    else byFile.set(r.fileId, [r]);
  }
  const out: TaskAttachment[] = [];
  for (const [fileId, chunks] of byFile) {
    const head = chunks[0];
    out.push({
      fileId,
      name: head.name,
      mime: head.mime,
      size: head.size,
      data: assembleFile(chunks, head.total),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.fileId.localeCompare(b.fileId));
}
