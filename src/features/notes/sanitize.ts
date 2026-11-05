// Санитайз HTML заметки. Содержимое — это HTML из contentEditable; чистим и
// на вставке, и на сохранении: заметки свои, не импортированные, но санитайз
// защищает от вставленного из буфера.
//
// Здесь стоял ALLOWED_CLASSES: { ul: ['cl'] } — такой опции у DOMPurify НЕТ
// (она из sanitize-html), незнакомые ключи конфига просто игнорируются. То
// есть class проходил целиком и на всех тегах — ровно наоборот тому, что
// обещал прежний комментарий. Приложение на Tailwind с глобальными
// утилитами, поэтому вставленный из веба фрагмент с class="hidden" давал
// сохранённый, но невидимый текст, а class="fixed inset-0 z-50" — блок
// поверх всего экрана.
//
// Класс нужен ровно один — маркер чек-листа. Оставляем его хуком, который
// работает уже ПОСЛЕ разбора атрибутов, и стираем всё остальное.

import DOMPurify from 'dompurify';
import { CHECKLIST_CLASS } from './checklist';

/** Единственный допустимый src картинки — встроенное изображение.
 *
 *  Вынесено из SANITIZE отдельной константой, потому что проверять приходится
 *  ДВАЖДЫ: конфигом и руками в хуке. Один ALLOWED_URI_REGEXP тут не
 *  справляется — у DOMPurify для data:-ссылок в img/video/audio своя ветка,
 *  которая проходит РАНЬШЕ нашего регекспа и пускает любой data:-URL
 *  (data:text/html, data:application/javascript, svg со скриптом внутри).
 *  Выполнения кода это сегодня не даёт — картинкой браузер скрипты не
 *  запускает, — но чужой блоб произвольного типа лёг бы в базу, уехал в синк
 *  и в копию. */
const INLINE_IMAGE = /^data:image\/(?:jpeg|png|gif|webp);base64,/i;

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof Element)) return;
  // Картинка не со встроенным изображением — уже не картинка, а пустая рамка
  // в тексте или чужой блоб. DOMPurify сам удаляет только атрибут; узел
  // убираем целиком.
  if (node.tagName === 'IMG' && !INLINE_IMAGE.test(node.getAttribute('src') ?? '')) {
    node.remove();
    return;
  }
  if (!node.hasAttribute('class')) return;
  const keep = node.tagName === 'UL' && node.classList.contains(CHECKLIST_CLASS);
  if (keep) node.setAttribute('class', CHECKLIST_CLASS);
  else node.removeAttribute('class');
});

export const SANITIZE = {
  ALLOWED_TAGS: ['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
    'ul', 'ol', 'li', 'h1', 'h2', 'span', 'blockquote', 'img'],
  // start — у нумерованного списка, начатого не с единицы: без него «5. 6. 7.»
  // из документа молча перенумеровывались с первого пункта.
  ALLOWED_ATTR: ['class', 'data-done', 'src', 'alt', 'start'],
  // Единственный URI-атрибут в списке — src у <img>, и он принимает ТОЛЬКО
  // встроенную картинку (сжатый JPEG dataURL, как фото в чате и «Местах»).
  // Дефолтный фильтр DOMPurify data: не пускает вовсе, а внешние http(s)-
  // картинки не пускаем мы: заметка офлайн-PWA не должна тянуть чужие URL
  // (трекинг-пиксели из вставленного веба, битые картинки без сети).
  ALLOWED_URI_REGEXP: INLINE_IMAGE,
  // ALLOWED_URI_REGEXP у DOMPurify проверяет значение ЛЮБОГО атрибута, не
  // только ссылочного: без этой строки start="5" у списка не проходил
  // («5» — не data:image) и тихо пропадал. class и alt спасает собственный
  // список безопасных атрибутов DOMPurify, data-done — ветка data-*.
  ADD_URI_SAFE_ATTR: ['start'],
};

/** Санитайз содержимого заметки перед вставкой в DOM и перед сохранением. */
export function sanitizeNoteHtml(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE);
}
