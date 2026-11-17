// Распознавание адреса в тексте, который никто не размечал ссылкой: набранном
// руками или вставленном простым текстом (мессенджеры кладут в буфер только
// text/plain — разметки, из которой можно было бы взять href, там нет вовсе).
//
// Жадность выбрана Владом 06.11.2026. Опасность здесь одна и она не
// теоретическая: заметка полна слов с точкой внутри — «отчёт.pdf»,
// «счёт.docx», «ст.3», «итого.Всего». Распознавай мы любую точку между
// буквами, половина делового текста загорелась бы золотом и стала бы
// кликабельной. Поэтому домен без протокола считается адресом ТОЛЬКО если
// его зона есть в списке ниже: «pdf» и «docx» в него не входят, а «com» и
// «ru» входят. Цена честная и названа: редкая зона (.xyz, .africa) ссылкой
// не станет, пока её сюда не допишут.
//
// Телефон намеренно НЕ распознаётся: в заметках слишком много чисел с
// дефисами — даты, суммы, артикулы, номера счетов.

/** Зоны, после которых домен без протокола считается адресом. */
const ZONES = 'ru|рф|com|org|net|io|me|dev|su|by|kz|ua|info|online|store|site|tv';

/** Метка домена: буква или цифра по краям, дефис допускается внутри. */
const LABEL = '[\\p{L}\\d](?:[\\p{L}\\d-]*[\\p{L}\\d])?';

/** Домен с зоной из списка. */
const HOST = `(?:${LABEL}\\.)+(?:${ZONES})`;

/** Домен, начинающийся с www. — зона любая: «www.» сам по себе достаточно
 *  явно говорит, что это адрес, и ложным срабатыванием не бывает. */
const WWW = `www\\.(?:${LABEL}\\.)*${LABEL}`;

/** Путь, параметры и якорь после домена. */
const PATH = '(?:[/?#][^\\s<>"«»]*)?';

/** Знаки, которые в конце адреса почти всегда принадлежат предложению, а не
 *  адресу: «зайди на vk.com/market, там дешевле». */
const TRAILING = /[.,;:!?)»"'\]]+$/;

function address(): RegExp {
  return new RegExp(
    [
      // Явный адрес с протоколом — берём до первого пробела.
      'https?://[^\\s<>"«»]+',
      // Почта. Стоит ВЫШЕ домена: иначе из «buh@zavod.ru» ссылкой стал бы
      // только «zavod.ru», а знак @ с именем остались бы снаружи.
      `[\\p{L}\\d][\\p{L}\\d._%+-]*@${HOST}`,
      // Домен без протокола.
      `(?:${WWW}|${HOST})${PATH}`,
    ].join('|'),
    'giu',
  );
}

/** Кусок строки: обычный текст или адрес (тогда есть href). */
export interface Piece {
  text: string;
  href?: string;
}

/** Домен регистра не имеет: «Vk.com» и «vk.com» — один и тот же адрес.
 *
 *  Нужно это из-за соседней способности редактора: первую букву строки он
 *  поднимает в заглавную (autocapitalize.ts), и адрес, набранный с новой
 *  строки — а это самый частый случай, — выглядел бы «Vk.com/market» и вёл
 *  бы на «https://Vk.com/market».
 *
 *  Опускаем регистр ТОЛЬКО у схемы и домена. Путь, параметры и якорь
 *  регистрозависимы: «/Kabel» и «/kabel» — разные страницы. У почты имя до @
 *  тоже не трогаем. Длина строки при этом не меняется ни на символ, поэтому
 *  смещение каретки в редакторе остаётся верным. */
function lowerHost(found: string): string {
  const m = /^(https?:\/\/)?([^/?#]*)([\s\S]*)$/i.exec(found);
  if (!m) return found;
  const scheme = m[1] ?? '';
  const host = m[2] ?? '';
  const rest = m[3] ?? '';
  const at = host.lastIndexOf('@');
  const domain = at === -1 ? host.toLowerCase() : host.slice(0, at + 1) + host.slice(at + 1).toLowerCase();
  return scheme.toLowerCase() + domain + rest;
}

/** Адрес → href. Почте нужен mailto:, домену без протокола — https://. */
export function hrefFor(found: string): string {
  if (/^https?:/i.test(found)) return found;
  if (found.includes('@')) return `mailto:${found}`;
  return `https://${found}`;
}

/** Разбить строку на текст и адреса. Пустой массив не возвращает: строка без
 *  адресов приходит обратно одним куском. */
export function splitByAddress(text: string): Piece[] {
  const re = address();
  const out: Piece[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let found = m[0];
    // Хвостовую точку или запятую возвращаем предложению. Делаем это ПОСЛЕ
    // поиска, а не в самом выражении: иначе пришлось бы описывать «любой
    // символ, кроме знаков препинания, но последним можно», и выражение
    // перестало бы читаться.
    const trail = TRAILING.exec(found);
    if (trail) found = found.slice(0, found.length - trail[0].length);
    if (found === '') continue;
    const shown = lowerHost(found);
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: shown, href: hrefFor(shown) });
    last = m.index + found.length;
    re.lastIndex = last;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}

/** Есть ли в строке хоть один адрес. */
export function hasAddress(text: string): boolean {
  return splitByAddress(text).some((p) => p.href);
}

/** Превратить адреса в живом DOM редактора в ссылки.
 *
 *  Текст не меняется ни на символ — только оборачивается, поэтому смещение
 *  каретки, снятое до вызова, остаётся верным и после.
 *
 *  Возвращает true, если что-то обернули. */
export function linkifyIn(root: HTMLElement): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    // Уже внутри ссылки — не трогаем: там адрес задан явно (из буфера), и он
    // может не совпадать с видимым текстом.
    if (t.parentElement?.closest('a')) continue;
    if (hasAddress(t.data)) targets.push(t);
  }
  for (const t of targets) {
    const frag = document.createDocumentFragment();
    for (const piece of splitByAddress(t.data)) {
      if (!piece.href) {
        frag.appendChild(document.createTextNode(piece.text));
        continue;
      }
      const a = document.createElement('a');
      a.setAttribute('href', piece.href);
      a.textContent = piece.text;
      frag.appendChild(a);
    }
    t.replaceWith(frag);
  }
  return targets.length > 0;
}
