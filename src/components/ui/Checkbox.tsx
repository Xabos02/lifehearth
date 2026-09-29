import {
  GCheck as Check,
} from '../../components/ui/glyphs';
import { isLightColor, ON_COLOR_DARK } from '../../lib/colors';
import { t } from '../../lib/i18n';

interface Props {
  checked: boolean;
  onChange: () => void;
  /** hex-цвет проекта/привычки; по умолчанию акцентный */
  color?: string;
  size?: number;
}

/**
 * Невидимая область касания 44x44 (минимум Apple HIG) для кнопок, которые
 * визуально должны остаться мелкими: псевдоэлемент абсолютный и центрирован,
 * поэтому не меняет ни размер кнопки, ни раскладку — плотность списков
 * сохраняется. Тап по псевдоэлементу засчитывается самой кнопке.
 *
 * Живёт здесь, а не в index.css: утилитарные классы там задаются на весь
 * проект, а нам нужен один общий набор классов для всех мелких контролов.
 *
 * Осторожно: у элемента не должно быть overflow:hidden (обрежет и хит-зону),
 * а до соседнего интерактивного элемента нужно ≥11px зазора — иначе зоны
 * перекроются и промах уйдёт к тому, кто выше по DOM.
 */
// Реэкспорт: 25 мест уже импортируют константу отсюда, и переезд ради переезда
// им ни к чему. Определение — в hitSlop.ts.
export { HIT_SLOP_44 } from './hitSlop';
import { HIT_SLOP_44 } from './hitSlop';
import { STROKE_HEAVY } from './icons';

/** Чекбокс задачи — скруглённый квадрат (как в списках iOS). Пустой —
 *  спокойная серая рамка; выполненный — заливка цветом проекта/акцента
 *  и белая галочка. Лаконичнее прежнего крупного цветного кольца. */
export function TaskCheck({ checked, onChange, color, size = 22 }: Props) {
  const c = color || 'var(--lh-accent)';
  // На светлой заливке (белый, янтарный, золото по умолчанию) белая галочка
  // не видна — ставим тёмную.
  const checkColor = !color || isLightColor(color) ? ON_COLOR_DARK : '#fff';
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      aria-label={checked ? t('Снять отметку') : t('Выполнить')}
      className={`flex shrink-0 items-center justify-center rounded-[6px] border-[1.5px] transition-transform duration-150 active:scale-90 ${HIT_SLOP_44}`}
      style={{
        width: size,
        height: size,
        borderColor: c, // рамка цвета проекта и у пустого квадрата — видно цвет
        background: checked ? c : 'transparent',
      }}
    >
      {checked && <Check size={size - 10} color={checkColor} strokeWidth={STROKE_HEAVY} />}
    </button>
  );
}
