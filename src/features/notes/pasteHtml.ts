// Разбор буфера обмена в разметку заметки.
//
// Заметка понимает узкий набор тегов (sanitize.ts): строки, списки,
// подзаголовок, цитата, картинка. Всё остальное DOMPurify выбрасывает — но
// выбрасывает ТЕГ, оставляя его текст (KEEP_CONTENT по умолчанию). Для
// таблицы это означало катастрофу: <table><tr><td> не разрешены, и колонка
// из 22 строк, скопированная из Excel/WPS/Numbers/Google Sheets, приезжала
// ОДНОЙ слипшейся строкой — «Джаммеры 800-900Джаммеры 900-1000…». Заодно
// молча пропадала шапка таблицы: <thead> у DOMPurify в FORBID_CONTENTS, то
// есть удаляется вместе с содержимым. Тот же механизм склеивал <dl>, <section>
// и прочую блочную разметку, которой нет в списке заметки.
//
// Поэтому вставка разбирается в два хода. Сначала DOMPurify с РАСШИРЕННЫМ
// списком тегов — он по-прежнему режет скрипты, обработчики и чужие URL, но
// оставляет структуру (таблицу, заголовки, <pre>) и style, по которому Google
// Docs и Word задают жирный и курсив. Потом эта структура переводится в
// разметку заметки. И только после этого — обычный санитайз: наружу из модуля
// уходит ровно тот набор тегов, что и у сохранённой заметки, а style не
// доезжает до DOM вовсе.
//
// Первая строка вставки идёт БЕЗ обёртки <div>. Две причины: вставка в
// середину строки не должна её разрывать, а вставка в пустую заметку должна
// давать заголовок (заголовок здесь — ведущий «голый» текст, см. editorDom).

import DOMPurify from 'dompurify';
import { SANITIZE, sanitizeNoteHtml } from './sanitize';
import { CHECKLIST_CLASS, DONE_ATTR } from './checklist';

/** Разделитель колонок: два неразрывных пробела.
 *
 *  Обычные пробелы и табуляция в HTML схлопываются в один — колонки слиплись
 *  бы обратно. Таблиц заметка не умеет, выдумывать для них знак препинания
 *  («·», «—») значит дописывать в чужие данные символы, которых там не было.
 *  Неразрывный пробел — это пробел, просто нескладываемый. */
const CELL_GAP = '\u00A0\u00A0';

/** Теги, которые нужны ТОЛЬКО чтобы понять структуру вставки. До сохранения
 *  ни один из них не доживает: их переводит в строки заметки walk(). */
const PASTE_SANITIZE: Record<string, unknown> = {
  ...SANITIZE,
  ALLOWED_TAGS: [
    ...SANITIZE.ALLOWED_TAGS,
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
    'pre', 'code', 'h3', 'h4', 'h5', 'h6', 'del', 'ins',
    // Блочные теги, которых нет у заметки. Их обязательно ПУСТИТЬ сюда:
    // выброшенный тег оставляет текст, и две строки списка определений или
    // две секции статьи склеились бы в одну — ровно как ячейки таблицы.
    'hr', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'section', 'article',
    'aside', 'header', 'footer', 'main', 'nav', 'address', 'details', 'summary',
    'fieldset', 'legend',
  ],
  // style НЕ попадает в заметку: его читает styleTags() и переводит в теги
  // выделения, а финальный sanitizeNoteHtml его не пропускает. rowspan и
  // colspan нужны, чтобы собрать сетку таблицы, и тоже наружу не идут.
  ALLOWED_ATTR: [...SANITIZE.ALLOWED_ATTR, 'style', 'start', 'rowspan', 'colspan'],
  // ALLOWED_URI_REGEXP проверяет значение ЛЮБОГО атрибута: «2» у rowspan
  // не похоже на data:image, и без этой строки атрибут тихо пропадал, а
  // объединённые ячейки снова сдвигали строки.
  ADD_URI_SAFE_ATTR: ['start', 'rowspan', 'colspan'],
};

/** Тег выделения → тег, который понимает заметка. */
const EMPHASIS: Record<string, string> = {
  B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', INS: 'u', S: 's', STRIKE: 's', DEL: 's',
};

/** Теги, начинающие новую строку. */
const BLOCK = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'HR',
  'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION',
  'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'SECTION', 'ARTICLE', 'ASIDE',
  'HEADER', 'FOOTER', 'MAIN', 'NAV', 'ADDRESS', 'DETAILS', 'SUMMARY',
  'FIELDSET', 'LEGEND',
]);

/** Тот же список селектором — «есть ли внутри блок». */
const BLOCK_INSIDE = Array.from(BLOCK).join(',').toLowerCase();

const WEIGHT_BOLD = /font-weight\s*:\s*(?:bold(?:er)?|[6-9]00)/i;
const WEIGHT_NORMAL = /font-weight\s*:\s*(?:normal|[1-5]00)/i;
const ITALIC = /font-style\s*:\s*italic/i;
const UNDERLINE = /text-decoration[a-z-]*\s*:[^;]*underline/i;
const LINE_THROUGH = /text-decoration[a-z-]*\s*:[^;]*line-through/i;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Схлопнуть пробельные символы, как это сделал бы браузер.
 *
 *  Класс перечислен руками, а не \s: \s в JavaScript включает неразрывный
 *  пробел, и разделитель колонок схлопнулся бы вместе с обычными. */
function collapse(s: string): string {
  return s.replace(/[ \t\n\r\f\v]+/g, ' ');
}

function trimEdges(s: string): string {
  return s.replace(/^ +| +$/g, '');
}

/** Есть ли в строке хоть что-то, кроме пробелов и тегов. */
function hasContent(html: string): boolean {
  if (/<(img|br)\b/i.test(html)) return true;
  return hasText(html);
}

/** Есть ли в строке текст (картинка и перенос — не текст). */
function hasText(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').replace(/[\s\u00A0]/g, '') !== '';
}

function isList(n: Node): n is HTMLElement {
  return n instanceof HTMLElement && (n.tagName === 'UL' || n.tagName === 'OL');
}

/** Выделение, заданное не тегом, а стилем.
 *
 *  Google Docs и Word кладут в буфер жирный, курсив и зачёркивание именно
 *  так — тегов <b>/<i> там нет вовсе. Санитайз срезает style, и до этой
 *  ветки вся разметка текста терялась: зачёркнутая (то есть отменённая) цена
 *  в коммерческом предложении читалась как действующая. */
function styleTags(el: Element): string[] {
  const st = el.getAttribute('style');
  if (!st) return [];
  const out: string[] = [];
  if (WEIGHT_BOLD.test(st)) out.push('b');
  if (ITALIC.test(st)) out.push('i');
  if (UNDERLINE.test(st)) out.push('u');
  if (LINE_THROUGH.test(st)) out.push('s');
  return out;
}

/** Обёртка целого документа, а не выделение.
 *
 *  Google Docs кладёт в буфер весь фрагмент внутри
 *  <b style="font-weight:normal"> — атрибут style санитайз срезает, и без
 *  этой проверки ВСЯ вставка становилась жирной. */
function isDocumentWrapper(el: Element): boolean {
  return el.querySelector(BLOCK_INSIDE) !== null;
}

/** Отрисовать узел как содержимое ОДНОЙ строки. Вложенные блоки при этом
 *  разделяются пробелом: ячейка таблицы с двумя абзацами внутри — всё равно
 *  одна ячейка. */
function renderInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return esc(collapse(node.textContent ?? ''));
  if (!(node instanceof Element)) return '';
  const tag = node.tagName;
  if (tag === 'BR') return '<br>';
  if (tag === 'IMG') {
    const src = node.getAttribute('src');
    if (!src) return '';
    const alt = node.getAttribute('alt');
    return `<img src="${esc(src)}"${alt ? ` alt="${esc(alt)}"` : ''}>`;
  }
  const inner = Array.from(node.childNodes)
    .map((n) => (isList(n) ? renderList(n) : renderInline(n)))
    .join('');
  if (BLOCK.has(tag)) return inner === '' ? '' : ` ${inner} `;
  if (!hasContent(inner)) return inner;

  const style = node.getAttribute('style') ?? '';
  const marks = new Set<string>();
  const own = EMPHASIS[tag];
  // <b style="font-weight:normal"> — не жирный, а обёртка Google Docs.
  if (own && !(own === 'b' && WEIGHT_NORMAL.test(style))) marks.add(own);
  for (const m of styleTags(node)) marks.add(m);
  let html = inner;
  for (const m of marks) html = `<${m}>${html}</${m}>`;
  return html;
}

function renderListItem(li: Element): string {
  const inner = Array.from(li.childNodes)
    .map((n) => (isList(n) ? renderList(n) : renderInline(n)))
    .join('');
  const done = li.getAttribute(DONE_ATTR) === '1' ? ` ${DONE_ATTR}="1"` : '';
  return `<li${done}>${trimEdges(inner)}</li>`;
}

/** Список целиком — он уже в разметке заметки, нужно лишь почистить. */
function renderList(el: HTMLElement): string {
  const tag = el.tagName === 'OL' ? 'ol' : 'ul';
  const cls = el.classList.contains(CHECKLIST_CLASS) ? ` class="${CHECKLIST_CLASS}"` : '';
  const start = Number(el.getAttribute('start'));
  // Список, начатый не с единицы («5. 6. 7.» после разрыва в документе):
  // без атрибута пункты молча перенумеровывались с единицы.
  const startAttr = tag === 'ol' && start > 1 ? ` start="${start}"` : '';
  const items: string[] = [];
  for (const child of Array.from(el.children)) {
    if (child.tagName === 'LI') {
      items.push(renderListItem(child));
      continue;
    }
    if (!isList(child)) continue;
    // Вложенный список, лежащий РЯДОМ с пунктом, а не внутри него — так его
    // кладут Word и Google Docs. Прежде он выбрасывался целиком вместе со
    // всеми подпунктами.
    const nested = renderList(child);
    if (!nested) continue;
    if (items.length) {
      items[items.length - 1] = items[items.length - 1]!.replace(/<\/li>$/, `${nested}</li>`);
    } else {
      items.push(`<li>${nested}</li>`);
    }
  }
  return items.length ? `<${tag}${cls}${startAttr}>${items.join('')}</${tag}>` : '';
}

interface Line {
  /** 'text' — обычная строка заметки; её можно отдать без обёртки.
   *  'block' — готовый тег (список, подзаголовок, цитата). */
  kind: 'text' | 'block';
  html: string;
}

interface State {
  lines: Line[];
  cur: string;
}

function flush(st: State): void {
  const html = st.cur;
  st.cur = '';
  // Края НЕ срезаем здесь: крайние пробелы первой и последней строки нужны
  // при вставке в середину текста, иначе «итого » + «1200» склеивается в
  // «итого1200». Строки режет сборка в clipboardHtmlToNoteHtml.
  if (hasContent(html)) st.lines.push({ kind: 'text', html });
}

function pushBlock(st: State, html: string): void {
  flush(st);
  if (html) st.lines.push({ kind: 'block', html });
}

/** Строки одного узла — для цитаты, внутри которой свои абзацы. */
function linesOf(node: Node): string[] {
  const sub: State = { lines: [], cur: '' };
  walk(node.childNodes, sub);
  flush(sub);
  return sub.lines.map((l) => trimEdges(l.html));
}

/** Строка таблицы, внутри которой лежат свои блоки.
 *
 *  Так свёрстаны письма и рассылки (таблица-каркас), и так Word заворачивает
 *  таблицу в таблицу. Сминать такую строку в одну строку заметки нельзя. */
function rowHasBlocks(tr: Element): boolean {
  return tr.querySelector('table, ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6, p, div') !== null;
}

/** Строки таблицы, но НЕ строки вложенных в неё таблиц. */
function tableRows(table: Element): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(table.children)) {
    if (child.tagName === 'TR') out.push(child);
    else if (child.tagName === 'THEAD' || child.tagName === 'TBODY' || child.tagName === 'TFOOT') {
      for (const tr of Array.from(child.children)) if (tr.tagName === 'TR') out.push(tr);
    }
  }
  return out;
}

/** Ячейки строки таблицы в одну строку заметки.
 *
 *  Пустые ячейки в хвосте отбрасываются, строка целиком из пустых ячеек не
 *  даёт строки вовсе: выделение в таблице почти всегда захватывает пустой
 *  хвост, и без этого заметка начиналась бы с десятка пустых строк. */
function renderRow(tr: Element): string {
  const cells = Array.from(tr.children)
    .filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
    .map((c) => trimEdges(collapse(renderInline(c))));
  while (cells.length && !hasContent(cells[cells.length - 1]!)) cells.pop();
  return cells.join(CELL_GAP);
}

/** Таблица целиком — строка в строку, с учётом объединённых ячеек.
 *
 *  Объединённые ячейки есть в любой живой заявке и спецификации. Без учёта
 *  rowspan следующая строка съезжает ВЛЕВО и встаёт под чужие колонки: «M»
 *  оказывается под «Джаммеры», «900» под «S» — это уже не пропуск, а подмена
 *  смысла. Поэтому держим карту занятых колонок: продолжение объединённой
 *  ячейки даёт пустое место, а не сдвиг. Повторять в нём значение не стали:
 *  в заметке повтор читался бы как ещё одна позиция. */
function renderTable(table: Element, st: State): void {
  const held: number[] = [];
  for (const tr of tableRows(table)) {
    if (rowHasBlocks(tr)) {
      walk(tr.childNodes, st);
      flush(st);
      held.length = 0;
      continue;
    }
    const cells: string[] = [];
    let col = 0;
    const skipHeld = () => {
      while ((held[col] ?? 0) > 0) {
        held[col] = held[col]! - 1;
        cells[col] = '';
        col++;
      }
    };
    skipHeld();
    for (const cell of Array.from(tr.children)) {
      if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue;
      const text = trimEdges(collapse(renderInline(cell)));
      const across = Math.max(1, Number(cell.getAttribute('colspan')) || 1);
      const down = Math.max(1, Number(cell.getAttribute('rowspan')) || 1);
      for (let k = 0; k < across; k++) {
        cells[col] = k === 0 ? text : '';
        if (down > 1) held[col] = down - 1;
        col++;
        skipHeld();
      }
    }
    while (cells.length && !hasContent(cells[cells.length - 1] ?? '')) cells.pop();
    const line = cells.map((c) => c ?? '').join(CELL_GAP);
    if (hasContent(line)) st.lines.push({ kind: 'text', html: line });
  }
}

function walk(nodes: NodeListOf<ChildNode> | ChildNode[], st: State): void {
  for (const node of Array.from(nodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      st.cur += esc(collapse(node.textContent ?? ''));
      continue;
    }
    if (!(node instanceof Element)) continue;
    const tag = node.tagName;

    if (tag === 'BR') { st.cur += '<br>'; continue; }
    if (tag === 'IMG') { st.cur += renderInline(node); continue; }

    if (tag === 'UL' || tag === 'OL') { pushBlock(st, renderList(node as HTMLElement)); continue; }

    if (tag === 'TABLE') {
      flush(st);
      renderTable(node, st);
      flush(st);
      continue;
    }

    // Строка или секция без своей таблицы — так приезжает выделение куска
    // листа из некоторых редакторов. Объединённые ячейки тут не отследить:
    // карта колонок живёт у таблицы.
    if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
      flush(st);
      walk(node.childNodes, st);
      flush(st);
      continue;
    }
    if (tag === 'TR') {
      flush(st);
      if (rowHasBlocks(node)) {
        walk(node.childNodes, st);
      } else {
        const row = renderRow(node);
        if (hasContent(row)) st.lines.push({ kind: 'text', html: row });
      }
      continue;
    }

    if (tag === 'PRE') {
      flush(st);
      // Внутри <pre> перевод строки значим, а отступ держится пробелами —
      // в обычном HTML и то и другое схлопнулось бы. Пустые строки тоже
      // значимы: это разделение кода на части.
      for (const raw of (node.textContent ?? '').replace(/\r\n?/g, '\n').split('\n')) {
        const line = esc(raw.replace(/\t/g, '  ')).replace(/ {2,}/g, (m) => '\u00A0'.repeat(m.length - 1) + ' ');
        st.lines.push({ kind: 'text', html: line === '' ? '<br>' : line });
      }
      continue;
    }

    if (/^H[1-6]$/.test(tag)) {
      // Заголовок любого уровня — подзаголовок заметки: h1 в .note-editor
      // нарисован обычным текстом, то есть вставленная статья теряла всю
      // структуру, а h3–h6 санитайз выбрасывал вместе с переносом строки.
      const inner = trimEdges(renderInline(node));
      if (hasContent(inner)) pushBlock(st, `<h2>${inner}</h2>`);
      continue;
    }

    if (tag === 'BLOCKQUOTE') {
      const inner = linesOf(node).filter(hasContent).join('<br>');
      if (hasContent(inner)) pushBlock(st, `<blockquote>${inner}</blockquote>`);
      continue;
    }

    if (tag === 'HR') { flush(st); st.lines.push({ kind: 'text', html: '<br>' }); continue; }

    if (BLOCK.has(tag)) {
      flush(st);
      const before = st.lines.length;
      walk(node.childNodes, st);
      flush(st);
      // Пустой абзац — пустая строка: так в письмах и документах разделяют
      // абзацы, и без него проза склеивалась в сплошняк. Только <p>: пустых
      // <div> на веб-странице десятки (распорки вёрстки), и каждый дал бы
      // лишнюю пустую строку.
      if (tag === 'P' && st.lines.length === before) st.lines.push({ kind: 'text', html: '<br>' });
      continue;
    }

    // Всё прочее — содержимое одной строки (span, code, a, font, выделение).
    // Если внутри лежит блок, это не выделение, а обёртка документа.
    if (isDocumentWrapper(node)) { walk(node.childNodes, st); continue; }
    st.cur += renderInline(node);
  }
}

/** Пустые строки по краям вставки.
 *
 *  Chrome и Safari дописывают в конец буфера <br class="Apple-interchange-newline">,
 *  письма начинаются с пустого абзаца. И то и другое давало лишнюю строку, а
 *  ведущая пустая строка ещё и съедала заголовок заметки. */
function trimBlankEdges(lines: Line[]): Line[] {
  const blank = (l: Line) => l.kind === 'text' && !hasText(l.html) && !/<img\b/i.test(l.html);
  let from = 0;
  let to = lines.length;
  while (from < to && blank(lines[from]!)) from++;
  while (to > from && blank(lines[to - 1]!)) to--;
  return lines.slice(from, to);
}

/** HTML из буфера → разметка заметки. Пустая строка, если вставлять нечего. */
export function clipboardHtmlToNoteHtml(html: string): string {
  const frag = DOMPurify.sanitize(html, {
    ...PASTE_SANITIZE,
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;
  const st: State = { lines: [], cur: '' };
  walk(frag.childNodes, st);
  flush(st);
  const lines = trimBlankEdges(st.lines);
  if (lines.length === 0) return '';
  const last = lines.length - 1;
  const out = lines
    .map((l, i) => {
      if (l.kind === 'block') return l.html;
      // Своя внешняя сторона у первой и последней строки сохраняется —
      // вставка в середину строки не склеивает слова. Внутри блока такой
      // пробел всё равно не виден: браузер схлопывает его на краю строки.
      const html =
        lines.length === 1
          ? l.html
          : i === 0
            ? l.html.replace(/ +$/, '')
            : i === last
              ? l.html.replace(/^ +/, '')
              : trimEdges(l.html);
      return i === 0 ? html : `<div>${html}</div>`;
    })
    .join('');
  // Ещё раз обычным санитайзом: наружу уходит только то, что умеет заметка.
  return sanitizeNoteHtml(out);
}

/** Простой текст из буфера → разметка заметки, БУКВАЛЬНО.
 *
 *  Буквально — значит символы разметки показываются как символы («a<b»,
 *  «&amp;», «<script>»), перенос строки остаётся переносом, а отступы и
 *  табуляция не схлопываются в один пробел. */
export function plainTextToNoteHtml(text: string): string {
  const raw = text.replace(/\r\n?/g, '\n');
  // Хвостовой перенос есть почти в каждом буфере (Excel, терминал, редактор
  // кода) и означает конец последней строки, а не пустую строку после неё.
  const lines = raw.replace(/\n$/, '').split('\n').map((l) =>
    esc(l)
      .replace(/\t/g, CELL_GAP)
      .replace(/ {2,}/g, (m) => '\u00A0'.repeat(m.length - 1) + ' '),
  );
  return lines.map((l, i) => (i === 0 ? l : `<div>${l === '' ? '<br>' : l}</div>`)).join('');
}
