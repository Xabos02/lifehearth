import { useEffect, useRef, type RefObject } from 'react';
import { isRefused, shouldCapitalizeInLine, type CapitalizeMemo } from './autocapitalize';

/**
 * Заглавная буква в начале строки и пункта — для обычного textarea.
 *
 * В заметках то же самое сделано на contentEditable (NoteEditorPage), и правило
 * у них общее (lib/autocapitalize). Здесь другая механика чтения: у textarea
 * нет разметки, поэтому строку до каретки берём срезом значения — и маркер
 * списка «2. » оказывается частью текста. Правило это учитывает.
 *
 * Вставляем через execCommand, а не правкой value: он двигает каретку сам,
 * пишется в стек отмены (иначе «отменить» перепрыгивало бы через букву) и
 * поднимает обычное событие input — то есть React-состояние обновляется своим
 * же onChange, без второго источника правды.
 */
export function useAutoCapitalizeTextarea(ref: RefObject<HTMLTextAreaElement | null>) {
  const memo = useRef<CapitalizeMemo | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onBeforeInput = (ev: InputEvent) => {
      // Стёрли символ — запоминаем: если следом наберут ту же букву в то же
      // место, значит с нашей заменой не согласны (см. isRefused).
      if (ev.inputType.startsWith('deleteContent')) {
        if (memo.current) memo.current.undone = true;
        return;
      }
      if (ev.inputType !== 'insertText') return;
      const pos = el.selectionStart;
      if (pos !== el.selectionEnd) return; // идёт замена выделения — не наш случай
      if (isRefused(memo.current, ev.data ?? '', pos)) {
        memo.current = null; // уважили отказ — дальше эта позиция обычная
        return;
      }
      const lineStart = el.value.lastIndexOf('\n', pos - 1) + 1;
      if (!shouldCapitalizeInLine(el.value.slice(lineStart, pos), ev.data)) return;
      ev.preventDefault();
      document.execCommand('insertText', false, ev.data!.toUpperCase());
      memo.current = { char: ev.data!, offset: el.selectionStart, undone: false };
    };

    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  }, [ref]);
}
