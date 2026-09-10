import type { Ref } from 'react';
import { useLayoutEffect, useRef } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import {
  GChevronDown as ChevronDown,
  GSearch as Search,
  GClose as X,
} from '../../components/ui/glyphs';
import { t } from '../../lib/i18n';
import { ICON, STROKE_STRONG } from './icons';

const base =
  'w-full rounded-xl bg-surface-2 border border-hairline px-3.5 py-3 text-text placeholder:text-muted outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-2 focus:ring-accent/25';

/** Круглый крестик в начале поля — стирает весь набранный текст одним тапом.
 *  Абсолютное позиционирование: родитель должен быть relative; вертикаль
 *  задаётся className (top-1/2 -translate-y-1/2 для input, top-3 для textarea). */
export function ClearFieldButton({
  onClick,
  className = '',
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={t('Очистить поле')}
      // Не отдаём фокус из поля: тап по крестику не должен прятать клавиатуру.
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`absolute left-2 z-10 flex size-6 items-center justify-center rounded-full bg-muted/20 text-muted transition-transform active:scale-90 ${className}`}
    >
      <X size={ICON.inline} strokeWidth={STROKE_STRONG} />
    </button>
  );
}

/** Текстовое поле. onClear — показывает крестик очистки в начале текста
 *  (появляется, только когда есть что стирать). */
export function Input({
  className = '',
  onClear,
  style,
  ...props
  // ref прокидывается обычным пропом: в React 19 forwardRef для функциональных
  // компонентов не нужен, но в типе его надо объявить явно.
}: InputHTMLAttributes<HTMLInputElement> & {
  onClear?: () => void;
  ref?: Ref<HTMLInputElement>;
}) {
  const showClear = Boolean(onClear) && typeof props.value === 'string' && props.value.length > 0;
  // Пустое поле даты обязано ВЫГЛЯДЕТЬ пустым.
  //
  // WebKit рисует в незаполненном поле даты сегодняшнее число — бледно, но
  // цифрами, — и поле читается как заполненное. Владелец так и решил, что у
  // новой задачи уже стоит срок, жал «Убрать» и не понимал, почему дата не
  // уходит: убирать было нечего, поле и так пустое. Chromium в том же месте
  // показывает «дд.мм.гггг» — понятнее, но всё равно не «пусто».
  //
  // Поэтому: нативный текст в пустом поле прячем, а на его место кладём своё
  // слово. При фокусе прячем уже своё — иначе оно легло бы поверх сегментов,
  // которые человек в этот момент набирает (пока дата неполная, value пуст,
  // и класс сам не снимется).
  const isEmptyDate = props.type === 'date' && !props.value;
  const input = (
    <input
      className={`${base} ${isEmptyDate ? 'date-empty ' : ''}${className}`}
      // Инлайн-отступ (а не класс pl-10): гарантированно перебивает любые
      // px-* из className независимо от порядка утилит в собранном CSS.
      style={showClear ? { ...style, paddingLeft: '2.5rem' } : style}
      {...props}
    />
  );
  if (!onClear && !isEmptyDate) return input;
  return (
    <div className="group relative min-w-0 w-full">
      {showClear && onClear && (
        <ClearFieldButton onClick={onClear} className="top-1/2 -translate-y-1/2" />
      )}
      {isEmptyDate && (
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted group-focus-within:hidden">
          {props.placeholder || t('Не задан')}
        </span>
      )}
      {input}
    </div>
  );
}

export function Textarea({
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${base} resize-none ${className}`} {...props} />;
}

/** Компактный вид того же списка — «чип» в строке настроек, а не поле во всю
 *  ширину. Кегль ниже базового намеренно: на 320px в строке карточки остаётся
 *  250px, и с text-sm самый длинный вариант («Классический», 100.6px) вместе с
 *  подписью строки туда физически не влезает — при text-xs влезает с запасом. */
const compactBase =
  'rounded-lg border border-hairline bg-surface-2 py-1.5 pl-2 text-xs text-text outline-none transition-[border-color] focus:border-accent';

/** Выпадающий список в едином со всеми полями виде: та же тонкая граница и
 *  фокус-кольцо, что у Input, плюс своя стрелка (нативную убирает
 *  appearance-none — без неё поле не читалось бы как «список»).
 *
 *  Своя стрелка здесь не только про вид: системная стрелка Chromium рисуется
 *  ВНУТРИ content-box и съедает под себя ~40px (замер: на 375px в поле шириной
 *  137px под текст оставалось 78px), поэтому длинные варианты обрезались
 *  многоточием задолго до правой границы. padding-right это не лечит — стрелка
 *  рисуется поверх. Отсюда же pr-* с запасом: 25.5px под 14px-шеврон у right-1.5
 *  (42.5px под 18px у right-3 в базовом виде).
 *
 *  compact — вариант для строки настроек: ширина по контенту (по самому
 *  длинному варианту), сжиматься нечему, поэтому текст не режется никогда. */
export function Select({
  className = '',
  compact = false,
  style,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { compact?: boolean }) {
  return (
    <div className={`relative ${compact ? 'shrink-0' : 'w-full min-w-0'}`}>
      <select
        className={`${compact ? compactBase : base} cursor-pointer appearance-none ${compact ? 'pr-6' : 'pr-10'} ${className}`}
        // -webkit-appearance инлайном, а не классом: Tailwind 4 генерирует для
        // appearance-none только непрефиксную запись, а WebKit до iOS 15.4 её
        // игнорирует и продолжает рисовать системную стрелку поверх нашей.
        style={{ WebkitAppearance: 'none', ...style }}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={compact ? 14 : 18}
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted ${compact ? 'right-1.5' : 'right-3'}`}
      />
    </div>
  );
}

/** Поле, растущее за текстом — для названий и описаний без ограничения длины.
 *  Заменяет однострочный Input там, где текст может быть длинным: строка
 *  переносится и поле само тянется вниз, ничего не обрезается и не прячется в
 *  горизонтальный скролл. min-height задаётся через className (напр. min-h-…).
 *  onClear — крестик очистки в начале, как в остальных полях. */
export function AutoGrowTextarea({
  className = '',
  onClear,
  style,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { onClear?: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { value } = props;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  const showClear = Boolean(onClear) && typeof value === 'string' && value.length > 0;
  const ta = (
    <textarea
      ref={ref}
      rows={1}
      className={`${base} resize-none overflow-hidden ${className}`}
      style={showClear ? { ...style, paddingLeft: '2.5rem' } : style}
      {...props}
    />
  );
  if (!onClear) return ta;
  return (
    <div className="relative w-full min-w-0">
      {showClear && <ClearFieldButton onClick={onClear} className="top-3" />}
      {ta}
    </div>
  );
}

/** Поле поиска: лупа слева, крестик очистки справа (появляется, когда есть
 *  текст). Единый вид на всех экранах со списком (Поиск, Заметки, Места…). */
export function SearchField({
  value,
  onChange,
  placeholder,
  autoFocus,
  className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const show = value.length > 0;
  return (
    <div className={`relative ${className}`}>
      <Search
        size={ICON.base}
        className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted"
      />
      <input
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t('Поиск')}
        className={`${base} ${show ? 'pr-11 pl-10' : 'pl-10'}`}
      />
      {show && (
        <button
          type="button"
          aria-label={t('Очистить поиск')}
          // Не отдаём фокус из поля: тап по крестику не должен прятать клавиатуру.
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange('')}
          className="absolute top-1/2 right-2.5 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-full bg-muted/20 text-muted transition-transform active:scale-90"
        >
          <X size={ICON.inline} strokeWidth={STROKE_STRONG} />
        </button>
      )}
    </div>
  );
}

/** Подпись + контрол — стандартная строка формы в шитах. */
export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={className ? `block ${className}` : 'block'}>
      <span className="mb-1.5 block text-sm font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
