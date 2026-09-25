import { useMemo } from 'react';
import { renderMarkdown } from './renderMarkdown';

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
