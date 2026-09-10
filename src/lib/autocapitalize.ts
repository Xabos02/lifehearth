// Заглавная буква в начале строки и пункта списка.
//
// Общий модуль на два редактора: заметки (contentEditable, разметка настоящая)
// и описание задачи (textarea, где список — просто текст «1. …»). Отсюда две
// точки входа: shouldCapitalize для DOM и shouldCapitalizeInLine для строки.
//
// Клавиатура iOS капитализирует сама, но решает по пунктуации: заглавная идёт
// после точки. Внутри списка точек обычно нет — люди пишут пункты без них, —
// поэтому второй и все следующие пункты начинались со строчной, хотя каждый
// пункт это отдельное предложение. То же с новой строкой в теле заметки.
//
// Отсюда своя проверка: поднимаем регистр, только когда символ действительно
// ПЕРВЫЙ в своей строке. В середине слова или предложения не вмешиваемся
// никогда — иначе «и т.д.» превращалось бы в «И т.Д.».

/** Текст внутри блока ДО каретки. Пустая строка — каретка в самом начале. */
function textBeforeCaret(block: Element, sel: Selection): string {
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(block);
  range.setEnd(sel.anchorNode!, sel.anchorOffset);
  return range.toString();
}

/** Блок, которому принадлежит каретка: пункт списка, абзац, цитата, заголовок
 *  или сам редактор (первая строка заметки — голые текст-узлы в корне). */
function blockOf(node: Node | null, root: HTMLElement): Element | null {
  const el = node instanceof Element ? node : node?.parentElement;
  if (!el || !root.contains(el)) return null;
  return el.closest('li, p, div, h1, h2, blockquote') ?? root;
}

/** Символ, который вот-вот введут, — строчная буква? Цифры, знаки и уже
 *  заглавные не трогаем. */
function isLowercaseLetter(s: string): boolean {
  if (s.length !== 1) return false;
  const up = s.toUpperCase();
  return up !== s && s.toLowerCase() === s;
}

/** Начало пункта списка, набранного текстом: «1. », «2) », «- », «• », «* ».
 *
 *  В заметках список ведёт браузер, и текст пункта начинается с пустоты —
 *  там достаточно проверки «до каретки ничего нет». В описании задачи маркер
 *  это обычные символы в строке, поэтому после автонумерации перед кареткой
 *  стоит «2. », строка не пуста, и прежнее правило молчало. Ровно это владелец
 *  и видел: нумерация продолжается сама, а буква после неё строчная.
 */
const LINE_PREFIX = /^\s*(?:\d+[.)]|[-*•])?\s*$/;

/**
 * Поднимать ли регистр, если известен текст строки ДО каретки.
 *
 * Строковая версия правила — её можно проверить тестами, не поднимая браузер,
 * и она одна на оба редактора.
 */
export function shouldCapitalizeInLine(textBeforeCaret: string, data: string | null): boolean {
  if (!data || !isLowercaseLetter(data)) return false;
  return LINE_PREFIX.test(textBeforeCaret);
}

/**
 * Поднимать ли регистр у вводимого символа.
 *
 * Отдельной чистой функцией, а не веткой внутри обработчика: правило про
 * «первый символ строки» легко ломается краевыми случаями (пробел перед
 * кареткой, пустой пункт, каретка в корне редактора), и его надо уметь
 * проверять тестами, не поднимая браузер.
 */
export function shouldCapitalize(
  root: HTMLElement,
  sel: Selection | null,
  data: string | null,
): boolean {
  if (!data || !isLowercaseLetter(data)) return false;
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const anchor = sel.anchorNode;
  if (!anchor || !root.contains(anchor)) return false;
  const block = blockOf(anchor, root);
  if (!block) return false;
  // Только начало строки — с той же меркой, что и в textarea: отступ и маркер
  // списка, набранный руками, всё ещё считаются началом пункта.
  return shouldCapitalizeInLine(textBeforeCaret(block, sel), data);
}

/**
 * Отмена автозаглавной — как у клавиатуры iOS.
 *
 * Правило «первая буква строки — заглавная» без отмены означает, что строку
 * НЕЛЬЗЯ начать со строчной вообще: «iPhone» превращается в «IPhone», почта в
 * «Vladislaveeet@gmail.com», «sso-mil.ru» в «Sso-mil.ru». Стереть и набрать
 * заново не помогает — поднимет снова. Для заметок про товары и поставщиков
 * это попадание частое.
 *
 * Система запоминает отмену: стёр подставленную заглавную и набрал ту же букву
 * — второй раз не поднимает. Здесь так же, и хранить для этого нужно ровно
 * одно: какую букву мы подставили последней. Если следом человек стёр символ,
 * а потом вводит ту же букву в то же место — значит он с нами не согласен.
 */
export interface CapitalizeMemo {
  /** Символ, который мы подставили в верхнем регистре (исходный, строчный). */
  char: string;
  /** Смещение каретки в редакторе сразу после подстановки. */
  offset: number;
  /** Человек уже стёр нашу подстановку — ждём повторного ввода. */
  undone: boolean;
}

/** Отказался ли человек от нашей замены именно здесь и именно для этой буквы. */
export function isRefused(memo: CapitalizeMemo | null, data: string, offset: number): boolean {
  if (!memo || !memo.undone) return false;
  // Смещение то же, буква та же — это повтор после стирания, а не новая строка.
  return memo.char === data && memo.offset === offset + 1;
}
