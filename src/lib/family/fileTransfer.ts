// Чистая логика передачи файлов по семейному чату: нарезка/сборка dataURL и
// человеко-читаемые подписи. Ничего не знает про Dexie/WS — это делает
// familyChat.ts, здесь только преобразования строк.
//
// Почему чанки: сообщение уходит одним WS-фреймом на Durable Object, а фрейм
// ограничен 1 МиБ. Полезная нагрузка раздувается дважды base64 (сырой файл →
// dataURL, потом шифротекст → JSON) — по ×1,33 каждый раз. 400 КиБ сырых
// байт после этого превращаются примерно в 710 КиБ — с запасом под лимит.

import { getLang, t } from '../i18n';

/** Размер одного чанка в СЫРЫХ байтах исходного файла (до base64-раздувания). */
export const CHUNK_RAW_BYTES = 400 * 1024;

/** Потолок файла целиком: 8 МиБ = 20 чанков. Больше — начнёт вытеснять
 *  историю чата (сервер хранит последние 5000 сообщений). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Режет dataURL-СТРОКУ на куски по CHUNK_RAW_BYTES символов. Именно строковые
 *  срезы, а не декодирование base64: собирается обратно простой конкатенацией,
 *  и резать/клеить можно кусками произвольной длины без знания об алфавите
 *  base64 вовсе. Пустая строка даёт один пустой кусок — иначе assembleFile
 *  для 0-байтного файла никогда не увидела бы «все чанки на месте». */
export function splitDataUrl(dataUrl: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < dataUrl.length; i += CHUNK_RAW_BYTES) {
    chunks.push(dataUrl.slice(i, i + CHUNK_RAW_BYTES));
  }
  return chunks.length > 0 ? chunks : [''];
}

/** Собирает файл обратно из кусков. Куски могут прийти в любом порядке (сеть
 *  не гарантирует порядок доставки) и с дублями (переотправка из outbox при
 *  реконнекте) — последний дубль в массиве побеждает. undefined, если хотя бы
 *  одного индекса 0..total-1 не хватает: значит либо ещё не всё доехало, либо
 *  часть истории уже вытеснена ретеншном сервера. */
export function assembleFile(chunks: { idx: number; data: string }[], total: number): string | undefined {
  const byIdx = new Map<number, string>();
  for (const c of chunks) byIdx.set(c.idx, c.data); // более поздний элемент массива перезаписывает более ранний
  let out = '';
  for (let i = 0; i < total; i++) {
    const piece = byIdx.get(i);
    if (piece === undefined) return undefined;
    out += piece;
  }
  return out;
}

/** Округляет до 1 знака после запятой и печатает по-русски: целое — без
 *  дробной части («512»), дробное — через запятую («7,5»), как formatDays в
 *  CyclePage.tsx. */
function ruNumber(v: number): string {
  const rounded = Math.round(v * 10) / 10;
  if (Number.isInteger(rounded)) return String(rounded);
  // Десятичный разделитель следует за языком: 7,5 по-русски, 7.5 по-английски.
  return getLang() === 'en' ? String(rounded) : String(rounded).replace('.', ',');
}

/** «512 Б» / «512 КБ» / «1,2 МБ» — неразрывный пробел перед единицей, как в
 *  formatDays. Границы: КБ с 1024 байт, МБ с 1024×1024 байт. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return t('{n}\u00A0Б', { n: bytes });
  if (bytes < 1024 * 1024) return t('{n}\u00A0КБ', { n: ruNumber(bytes / 1024) });
  return t('{n}\u00A0МБ', { n: ruNumber(bytes / (1024 * 1024)) });
}

/** Короткая русская подпись типа файла по mime/расширению. Намеренно всего
 *  несколько групп (не десятки): для карточки в чате важно узнаваемое слово,
 *  а не точная классификация. Всё, что не попало ни в одну группу, — «Файл». */
export function fileKindLabel(mime: string, name: string): string {
  const m = (mime || '').toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';

  if (m === 'application/pdf' || ext === 'pdf') return 'Документ PDF';
  if (/zip|rar|7z-compressed|x-tar|gzip|x-7z/.test(m) || ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return 'Архив';
  }
  if (/spreadsheet|excel|\bcsv\b/.test(m) || ['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return 'Таблица';
  if (/^text\//.test(m) || ['txt', 'md'].includes(ext)) return 'Текст';
  return 'Файл';
}
