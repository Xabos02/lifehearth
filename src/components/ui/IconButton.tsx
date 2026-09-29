import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { HIT_SLOP_44 } from './hitSlop';
import { ICON, STROKE } from './icons';

type Tone = 'accent' | 'muted' | 'danger' | 'text' | 'frost';

const TONE: Record<Tone, string> = {
  accent: 'text-lh-accent',
  muted: 'text-lh-text-secondary',
  danger: 'text-danger',
  text: 'text-lh-text-primary',
  frost: 'text-frost',
};

interface Props {
  icon: LucideIcon;
  /** Что делает кнопка — уходит в aria-label. Иконка без подписи иначе немая. */
  label: string;
  onClick?: () => void;
  /** Вместо кнопки — ссылка на маршрут. */
  to?: string;
  tone?: Tone;
  /** Залить глиф текущим цветом — для состояний «включено» (закреплено). */
  filled?: boolean;
  size?: number;
  /** Вес штриха в пикселях (ui/icons.ts). По умолчанию обычный. */
  strokeWidth?: number;
  /** Только для оформления самой кнопки (подложка, свечение). Метрику не
   *  трогаем — ради неё компонент и заведён. */
  className?: string;
}

/**
 * Единственная кнопка-иконка для шапок экранов.
 *
 * Была на шести экранах шестью разными обёртками: p-1, p-1.5, p-2, size-10 и
 * два раза без ничего. Разница в 8px видна как неровный правый край при
 * переходе между разделами, а зону касания 44×44 половина из них не набирала.
 *
 * Метрика: видимый бокс 38px (глиф 20 + воздух), зона касания добирается до
 * 44×44 псевдоэлементом. -mx-1 возвращает глиф к тому же отступу от края
 * экрана, что был у варианта с p-1 — иначе воздух кнопки выглядит как лишний
 * отступ поля.
 */
export function IconButton({
  icon: Icon,
  label,
  onClick,
  to,
  tone = 'accent',
  filled = false,
  size = ICON.header,
  strokeWidth = STROKE,
  className = '',
}: Props) {
  const cls = `-mx-1 flex size-9 shrink-0 items-center justify-center rounded-full ${TONE[tone]} active:opacity-60 ${HIT_SLOP_44} ${className}`;
  // shrink-0 на глифе: без него любой padding из className съедает не бокс
  // кнопки (он фиксирован size-9), а саму иконку — глиф молча ужимался,
  // например с 20px до 13px.
  const glyph = (
    <Icon size={size} strokeWidth={strokeWidth} fill={filled ? 'currentColor' : 'none'} className="shrink-0" />
  );

  if (to) {
    return (
      <Link to={to} aria-label={label} className={cls}>
        {glyph}
      </Link>
    );
  }
  return (
    <button type="button" aria-label={label} onClick={onClick} className={cls}>
      {glyph}
    </button>
  );
}
