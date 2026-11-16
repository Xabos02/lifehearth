// Фото-панель наверху «Задач»: раскладка и хранение.
//
// ХРАНЕНИЕ. Отдельной таблицы нет: снимки панели лежат в той же taskPhotos,
// что и снимки задач, под служебным taskId. Там уже есть всё нужное — нарезка
// на куски под лимит записи синка, непрозрачные id на сервере, место в копии,
// терпимость к недоехавшим кускам. Новая таблица повторила бы это целиком.
// taskId задач — случайные uuid, со строкой BOARD_ID они не совпадут; ни
// миграция снимков, ни «Корзина» по ней не ходят (они идут от строк задач).
//
// РАСКЛАДКА. Требование владельца (16.11.2026): одно фото — во всю ширину,
// чем больше фото, тем они мельче, и любое фото видно целиком, без обрезки.

import type { TaskPhoto } from '../db/types';
import { db } from '../db/db';
import { createManyWithId, now, updateMany } from '../db/repo';
import { assembleFile } from './family/fileTransfer';
import { photoIdOf, planPhotoChunks } from './taskPhotos';

/** Служебный taskId снимков панели. */
export const BOARD_ID = 'tasks-board';
/** Больше не берём: на 9 снимках плитка уже около 115×86 на телефоне. */
export const BOARD_MAX = 9;
/** Зазор между плитками, px. */
export const BOARD_GAP = 6;

export interface BoardPhoto {
  photoId: string;
  src: string;
  /** Ширина / высота снимка. */
  aspect: number;
}

/** Плитка: рамка на панели. Снимок вписан в неё целиком; если пропорции рамки
 *  шире снимка, по бокам видна размытая копия того же снимка. */
export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardLayout {
  height: number;
  tiles: Tile[];
}

/** Предел высоты панели: три четверти ширины, но не выше 320 и не больше
 *  45% высоты окна. Иначе одно вертикальное фото во всю ширину заняло бы почти
 *  весь экран, а в альбомной ориентации — весь, и до задач пришлось бы листать. */
export function boardMaxHeight(width: number, viewportHeight = Infinity): number {
  return Math.min(Math.round(width * 0.75), 320, Math.round(viewportHeight * 0.45));
}

/** Все способы разбить n снимков на ряды подряд, без перестановки. */
function* compositions(n: number): Generator<number[]> {
  for (let mask = 0; mask < 1 << (n - 1); mask++) {
    const rows: number[] = [];
    let size = 1;
    for (let i = 0; i < n - 1; i++) {
      if (mask & (1 << i)) {
        rows.push(size);
        size = 1;
      } else size++;
    }
    rows.push(size);
    yield rows;
  }
}

/** Плитка не меньше зоны касания (PROTOCOL §5.1): по ней тапают, чтобы
 *  открыть снимок, и расширить зону за край плитки некуда — рядом соседняя. */
const MIN_TILE = 44;

/** Вес пустых полей против площади снимков при выборе раскладки. Подобран на
 *  девяти последовательностях «добавляю по одному снимку» (64 шага): при 1
 *  (поле так же плохо, как снимок хорош) с новым снимком остальные заметно
 *  КРУПНЕЛИ в 12 шагах — наоборот тому, что просили, — а три снимка
 *  сжимались в полоску 105px; при 0.5 — в 7 шагах, полей в среднем 13% против
 *  10%; при 0.25 — в 3 шагах, но полей 15%. Совсем рост не уходит ни при каком
 *  весе: одно вертикальное фото упирается в предел высоты, и второе рядом с
 *  ним честно крупнее среднего. */
const FILL_WEIGHT = 0.5;

/** Ряды по пропорциям снимков (вариант А канвы, выбран 16.11.2026).
 *
 *  В ряду у всех снимков одна высота, и ряд ровно заполняет ширину — каждый
 *  снимок остаётся в своих пропорциях, ничего не режется. Если так ряды не
 *  влезают по высоте, высота рядов ограничивается, а лишняя ширина делится
 *  между рамками ряда (там и видна размытая подложка).
 *
 *  Выбор в два шага (см. ниже). Перебор полный: при 9 снимках это 256
 *  разбиений, около миллисекунды; больше 9 бывает только после синка двух
 *  устройств, там ровная сетка — перебор 2^(n−1) на 18 снимках шёл секунду.
 */
export function boardLayout(aspects: number[], width: number, maxHeight: number, gap = BOARD_GAP): BoardLayout {
  const n = aspects.length;
  if (n === 0 || width <= 0) return { height: 0, tiles: [] };
  if (n > BOARD_MAX) return gridLayout(aspects, width, maxHeight, gap);

  /** Высота каждого ряда, при которой он ровно заполняет ширину. */
  const fullHeights = (rows: number[]) => {
    const out: number[] = [];
    let start = 0;
    for (const size of rows) {
      const sum = aspects.slice(start, start + size).reduce((s, a) => s + a, 0);
      out.push((width - gap * (size - 1)) / sum);
      start += size;
    }
    return out;
  };
  /** Ширина рамки от потолка высоты не зависит: ряд всегда во всю ширину. */
  const narrow = (rows: number[]) => {
    let start = 0;
    return rows.some((size) => {
      const row = aspects.slice(start, (start += size));
      const sum = row.reduce((s, a) => s + a, 0);
      // +1 — запас на округление краёв до целых пикселей.
      return row.some((a) => ((width - gap * (size - 1)) * a) / sum < MIN_TILE + 1);
    });
  };

  // Шаг 1. Для каждого числа рядов — самое ровное разбиение: самый низкий ряд
  // как можно выше. Без этого шага выигрывали перекошенные раскладки — два
  // крупных снимка сверху и семь «марок» снизу.
  const evenest = new Map<number, { rows: number[]; full: number[] }>();
  for (const rows of compositions(n)) {
    if (narrow(rows)) continue;
    const full = fullHeights(rows);
    const lo = Math.min(...full);
    const prev = evenest.get(rows.length);
    if (!prev) {
      evenest.set(rows.length, { rows, full });
      continue;
    }
    const prevLo = Math.min(...prev.full);
    if (lo > prevLo * 1.0001 || (lo > prevLo * 0.9999 && Math.max(...full) < Math.max(...prev.full)))
      evenest.set(rows.length, { rows, full });
  }

  // Шаг 2. Каждое такое разбиение вписываем в предел высоты и выбираем, где
  // снимки крупнее за вычетом пустых полей (с весом FILL_WEIGHT).
  let best: { rows: number[]; heights: number[]; score: number } | null = null;
  for (const { rows, full } of [...evenest.values()].sort((a, b) => a.rows.length - b.rows.length)) {
    // Потолок ряда t: наибольший, при котором панель влезает в maxHeight.
    // Сумма min(full, t) растёт по t, поэтому бинарный поиск.
    const room = maxHeight - gap * (rows.length - 1);
    if (room <= 0) continue;
    const total = (t: number) => full.reduce((s, h) => s + Math.min(h, t), 0);
    let cap = Math.max(...full);
    if (total(cap) > room) {
      let lo = 0;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + cap) / 2;
        if (total(mid) <= room) lo = mid;
        else cap = mid;
      }
      cap = lo;
    }
    const heights = full.map((h) => Math.min(h, cap));
    if (Math.min(...heights) < MIN_TILE + 1) continue;
    let score = 0;
    let start = 0;
    rows.forEach((size, r) => {
      const h = heights[r];
      const photo = aspects.slice(start, start + size).reduce((s, a) => s + a * h * h, 0);
      const frame = (width - gap * (size - 1)) * h;
      score += photo - FILL_WEIGHT * (frame - photo);
      start += size;
    });
    // Перебор идёт от меньшего числа рядов: при равенстве остаётся то, где
    // рядов меньше, — спокойнее выглядит.
    if (!best || score > best.score * 1.0001) best = { rows, heights, score };
  }
  // Ни одно разбиение не держит плитки от 44px (снимки крайних пропорций
  // вперемешку) — ровная сетка держит всегда.
  if (!best) return gridLayout(aspects, width, maxHeight, gap);

  // Целые пиксели: края считаем от накопленной суммы, чтобы ошибка округления
  // не копилась и последний снимок ряда упирался ровно в край.
  const tiles: Tile[] = [];
  let y = 0;
  let start = 0;
  best.rows.forEach((size, r) => {
    // Вниз, а не к ближайшему: иначе сумма рядов вылезала за предел на 1px.
    // +1e-6: бинарный поиск останавливается на 270.99999 вместо 271.
    const h = Math.floor(best.heights[r] + 1e-6);
    const row = aspects.slice(start, start + size);
    const sum = row.reduce((s, a) => s + a, 0);
    const inner = width - gap * (size - 1);
    let acc = 0;
    row.forEach((a, i) => {
      const x0 = Math.round(acc + gap * i);
      acc += (inner * a) / sum;
      const x1 = i === size - 1 ? width : Math.round(acc + gap * i);
      tiles.push({ x: x0, y, w: x1 - x0, h });
    });
    y += h + gap;
    start += size;
  });
  return { height: y - gap, tiles };
}

/** Ровная сетка (вариант Б канвы): одна, две или три колонки по числу снимков,
 *  все рамки одного размера, снимок вписан в рамку целиком. */
export function gridLayout(aspects: number[], width: number, maxHeight: number, gap = BOARD_GAP): BoardLayout {
  const n = aspects.length;
  if (n === 0 || width <= 0) return { height: 0, tiles: [] };
  if (n === 1) {
    const h = Math.floor(Math.min(width / aspects[0], maxHeight));
    return { height: h, tiles: [{ x: 0, y: 0, w: width, h }] };
  }
  const cols = n === 3 || n > 4 ? 3 : 2;
  const rowsCount = Math.ceil(n / cols);
  const cell = (width - gap * (cols - 1)) / cols;
  const h = Math.floor(Math.min(cell, (maxHeight - gap * (rowsCount - 1)) / rowsCount));
  const tiles: Tile[] = [];
  for (let r = 0; r < rowsCount; r++) {
    const inRow = Math.min(cols, n - r * cols);
    const w = (width - gap * (inRow - 1)) / inRow;
    for (let c = 0; c < inRow; c++) {
      const x0 = Math.round(c * (w + gap));
      const x1 = c === inRow - 1 ? width : Math.round(c * (w + gap) + w);
      tiles.push({ x: x0, y: r * (h + gap), w: x1 - x0, h });
    }
  }
  return { height: rowsCount * h + gap * (rowsCount - 1), tiles };
}

/** Собрать снимки панели из кусков — в порядке добавления.
 *
 *  Порядок по createdAt первого куска: время едет синком вместе с записью,
 *  поэтому на обоих устройствах порядок одинаковый. Снимок с недоехавшим
 *  куском пропускается — лучше показать три из четырёх, чем битую картинку. */
export function assembleBoard(rows: TaskPhoto[]): BoardPhoto[] {
  const byPhoto = new Map<string, TaskPhoto[]>();
  for (const r of rows) {
    if (r.deletedAt || r.taskId !== BOARD_ID) continue;
    const list = byPhoto.get(r.photoId);
    if (list) list.push(r);
    else byPhoto.set(r.photoId, [r]);
  }
  const out: Array<BoardPhoto & { at: string }> = [];
  for (const [photoId, chunks] of byPhoto) {
    const src = assembleFile(
      chunks.map((c) => ({ idx: c.idx, data: c.data })),
      chunks[0].total,
    );
    if (!src) continue;
    // Пропорции из записи — в разумных пределах: битое значение (0, NaN,
    // бесконечность) сломало бы раскладку всей панели.
    const raw = chunks.find((c) => Number.isFinite(c.aspect) && c.aspect! > 0)?.aspect ?? 1;
    const aspect = Math.min(10, Math.max(0.1, raw));
    const at = chunks.reduce((m, c) => (c.createdAt < m ? c.createdAt : m), chunks[0].createdAt);
    out.push({ photoId, src, aspect, at });
  }
  out.sort((a, b) => (a.at === b.at ? (a.photoId < b.photoId ? -1 : 1) : a.at < b.at ? -1 : 1));
  return out.map(({ photoId, src, aspect }) => ({ photoId, src, aspect }));
}

/** Положить снимок на панель. id кусков — от содержимого, поэтому повторное
 *  добавление того же снимка не плодит копию. Куски пишутся одной транзакцией
 *  и с одной меткой времени: оборванная запись не оставит невидимого и
 *  неудаляемого куска, а синк решает «кто новее» по всему снимку сразу. */
export async function addBoardPhoto(dataUrl: string, aspect: number): Promise<void> {
  const photoId = await photoIdOf(dataUrl);
  await createManyWithId(
    db.taskPhotos,
    planPhotoChunks(BOARD_ID, photoId, dataUrl).map(({ id, row }) => ({ id, data: { ...row, aspect } })),
  );
}

/** Убрать снимок с панели.
 *
 *  Содержимое кусков стирается вместе с пометкой удаления: удалённые записи в
 *  приложении не вычищаются никогда, и без этого каждый убранный снимок вечно
 *  занимал бы до мегабайта и на телефоне, и на сервере. Поэтому перед вызовом
 *  — подтверждение: вернуть снимок потом будет неоткуда. */
export async function removeBoardPhoto(photoId: string): Promise<void> {
  const chunks = await db.taskPhotos
    .where('taskId')
    .equals(BOARD_ID)
    .filter((r) => r.photoId === photoId && !r.deletedAt)
    .toArray();
  const ts = now();
  await updateMany(
    db.taskPhotos,
    chunks.map((c) => ({ id: c.id, changes: { data: '', deletedAt: ts } })),
  );
}
