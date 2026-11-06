// Работа со структурой contenteditable в редакторе заметок.
//
// Заметка — один редактируемый блок, а не «поле заголовка + поле текста».
// Заголовок здесь — это ведущий «голый» текст до первого блочного тега: стиль
// заголовка задаёт база .note-editor, а любой блок (div/p/ul/…) сбрасывает его
// до обычного (см. index.css).
//
// Пока человек набирает руками, инвариант держится сам: браузер оставляет
// первую строку текстовым узлом и оборачивает в <div> только следующие. Но
// вставка из буфера приносит готовую разметку, и первая строка приезжает уже
// внутри <div> или <p> — заголовок молча превращался в обычный текст. Из
// мессенджера, где в буфере только plain text, всё было хорошо; из браузера,
// Word или редактора документов — нет.

/** Блоки, которые могут оказаться ведущими и «съесть» заголовок. Списки и
 *  готовые h1/h2 не трогаем: если заметка начинается со списка, значит
 *  заголовка у неё нет, и выдумывать его не надо. */
const UNWRAPPABLE = new Set(['DIV', 'P']);

/** Смещение каретки в тексте корня — чтобы пережить перестройку DOM.
 *  Считается по видимому тексту, без переводов строк между блоками: ровно так
 *  же его потом восстанавливает setCaretAtOffset. */
export function caretOffset(root: HTMLElement): number | null {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !root.contains(sel.anchorNode)) {
    return null;
  }
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(sel.anchorNode, sel.anchorOffset);
  return range.toString().length;
}

/** Поставить каретку на смещение в тексте. Если содержимое короче — в конец. */
export function setCaretAtOffset(root: HTMLElement, offset: number): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let node: Node | null;
  const sel = document.getSelection();
  if (!sel) return;
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0;
    if (acc + len >= offset) {
      const range = document.createRange();
      range.setStart(node, Math.max(0, offset - acc));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    acc += len;
  }
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Есть ли текст в строке, где стоит каретка.
 *
 *  Нужно перед блочными командами: возвращать каретку по смещению можно
 *  только на НЕПУСТОЙ строке. На пустой смещение обманывает — «конец
 *  заголовка» и «начало пустого пункта сразу под ним» дают одно и то же число
 *  символов, и восстановление утаскивало каретку обратно в заголовок вместо
 *  только что созданного пункта.
 *
 *  Каретка прямо в корне редактора (anchorNode === root) — это положение
 *  «между блоками», которое iOS даёт после Enter. Строки там нет, значит и
 *  текста нет. */
export function caretLineHasText(root: HTMLElement): boolean {
  const sel = document.getSelection();
  const anchor = sel?.anchorNode;
  if (!anchor || !root.contains(anchor)) return false;
  if (anchor === root) return false;
  const host = anchor instanceof Element ? anchor : anchor.parentElement;
  const block = host?.closest('li, p, div, h1, h2, blockquote');
  // Блока нет — значит это голый текст в корне, то есть заголовок заметки.
  if (!block) return (anchor.textContent ?? '').trim() !== '';
  return (block.textContent ?? '').trim() !== '';
}

/** Стоит ли каретка в самом начале своей строки.
 *
 *  Отдельно от caretLineHasText, потому что вопрос другой: там «строка пустая
 *  ли», здесь «пусто ли ПЕРЕД кареткой». Начало непустой строки — ровно та
 *  точка, где смещение по видимому тексту становится неоднозначным: «конец
 *  предыдущей строки» и «начало этой» дают одно и то же число символов. */
export function caretAtLineStart(root: HTMLElement): boolean {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return false;
  const anchor = sel.anchorNode;
  if (!root.contains(anchor)) return false;
  if (anchor === root) return true; // «между блоками» — начало по определению
  const host = anchor instanceof Element ? anchor : anchor.parentElement;
  const block = host?.closest('li, p, div, h1, h2, blockquote') ?? root;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(block);
  r.setEnd(anchor, sel.anchorOffset);
  return r.toString() === '';
}

/** Развернуть ведущий блок, чтобы первая строка снова стала заголовком.
 *
 *  Возвращает true, если структура изменилась — вызывающему это нужно, чтобы
 *  не дёргать сохранение впустую.
 *
 *  Разворачиваем только «простой» ведущий блок: если внутри него своя
 *  структура (вложенные абзацы, список), это не одна строка, и вытаскивать её
 *  наружу значило бы ломать вставленный документ. */
export function unwrapLeadingBlock(root: HTMLElement): boolean {
  const first = root.firstChild;
  if (!first || first.nodeType !== Node.ELEMENT_NODE) return false;
  const block = first as HTMLElement;
  if (!UNWRAPPABLE.has(block.tagName)) return false;
  if (block.querySelector('div, p, ul, ol, li, h1, h2, blockquote, pre')) return false;

  // Пустой ведущий блок — это пустая первая строка. Разворачивать нечего, но и
  // оставлять нельзя: заголовок оказался бы во второй строке. Просто убираем.
  if (!block.textContent?.trim() && !block.querySelector('br, img')) {
    block.remove();
    return true;
  }
  const frag = document.createDocumentFragment();
  while (block.firstChild) frag.appendChild(block.firstChild);
  // Разделитель между заголовком и телом: без него следующий блок прилипнет к
  // заголовку и станет его частью при следующем развороте.
  root.replaceChild(frag, block);
  return true;
}

/** Блоки, которые сбрасывают стиль заголовка (см. index.css). */
const BLOCK_TAGS = new Set(['DIV', 'P', 'UL', 'OL', 'H1', 'H2', 'BLOCKQUOTE', 'PRE', 'LI']);

/** Завернуть «голый» текст, оказавшийся ПОСЛЕ первого блока.
 *
 *  Заголовок заметки — это ведущий голый текст. Но база .note-editor красит
 *  заголовочным кеглем ЛЮБОЙ голый текст в корне, где бы он ни лежал. Такой
 *  текст появляется сам собой: голосовой ввод дописывает узел в конец корня,
 *  вставка в середину заголовка выносит его хвост за вставленные блоки. В
 *  обоих случаях посреди заметки оказывалась строка 24-м жирным кеглем, и
 *  убрать её можно было только стерев и набрав заново.
 *
 *  Ведущий текст не трогаем: это и есть заголовок. */
export function wrapStrayText(root: HTMLElement): boolean {
  let seenBlock = false;
  let changed = false;
  let run: ChildNode[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    const div = document.createElement('div');
    run[0]!.before(div);
    for (const n of run) div.appendChild(n);
    run = [];
    changed = true;
  };
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as Element).tagName)) {
      flushRun();
      seenBlock = true;
      continue;
    }
    if (!seenBlock) continue;
    // Пробельный узел между блоками — не строка, а форматирование разметки.
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '') continue;
    run.push(node);
  }
  flushRun();
  return changed;
}

/** Разнести блоки, попавшие ВНУТРЬ пункта списка, по отдельным пунктам.
 *
 *  Вставка многострочного текста кладёт в каретку строки блоками. Если каретка
 *  стояла в пункте списка, все они оказывались внутри ОДНОГО <li>: список из 22
 *  товаров становился одним пунктом высотой в экран. Человек ждёт 22 пункта —
 *  так ведут себя заметки в iOS. */
export function splitBlocksInListItems(root: HTMLElement): boolean {
  let changed = false;
  for (const li of Array.from(root.querySelectorAll('li'))) {
    const blocks = Array.from(li.children).filter((c) => c.tagName === 'DIV' || c.tagName === 'P');
    let anchor: Element = li;
    for (const block of blocks) {
      const next = document.createElement('li');
      while (block.firstChild) next.appendChild(block.firstChild);
      block.remove();
      anchor.after(next);
      anchor = next;
      changed = true;
    }
  }
  return changed;
}

/** Снять инлайн-стили, навешанные браузером.
 *
 *  execCommand('insertHTML') в Chrome «сохраняет вид» вставляемого куска: он
 *  берёт вычисленный стиль того места, где собирает фрагмент, — а корень
 *  редактора здесь нарисован стилем ЗАГОЛОВКА — и вешает его инлайном. Первая
 *  строка вставки оказывалась 24-м жирным посреди тела заметки, и до
 *  перезагрузки это не лечилось: санитайз срезает style лишь при сохранении,
 *  то есть на экране и в базе было разное.
 *
 *  Своих инлайн-стилей у заметки нет вовсе (их не пропускает санитайз), так
 *  что снимать можно все. */
export function stripInlineStyles(root: HTMLElement): boolean {
  const styled = Array.from(root.querySelectorAll('[style]'));
  for (const el of styled) el.removeAttribute('style');
  return styled.length > 0;
}

/** Привести структуру к инварианту, сохранив позицию каретки. */
export function normalizeEditor(root: HTMLElement): boolean {
  const offset = caretOffset(root);
  // Порядок важен: сначала разворот ведущего блока (он смотрит на первый узел
  // корня), потом разбивка пунктов, и только потом заворачивание того, что
  // осталось голым в корне.
  let changed = stripInlineStyles(root);
  changed = unwrapLeadingBlock(root) || changed;
  changed = splitBlocksInListItems(root) || changed;
  changed = wrapStrayText(root) || changed;
  if (changed && offset !== null) setCaretAtOffset(root, offset);
  return changed;
}
