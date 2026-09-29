import { useState, type ComponentType, type ReactNode } from 'react';
import { Lightbulb } from 'lucide-react';
import {
  GClose as X,
} from '../../components/ui/glyphs';
import { t } from '../../lib/i18n';
import { useHint } from '../../hooks/useHint';
import { HIT_SLOP_44 } from './Checkbox';
import { ICON } from './icons';

export interface HintItem {
  icon: ComponentType<{ size?: number | string; className?: string }>;
  text: ReactNode;
}

/** Карточка-подсказка: одноразовый совет в контексте раздела.
 *
 *  Структурированный вид: заголовок + пункты, каждый со своей мини-иконкой —
 *  читается по строкам, а не сплошным абзацем. children остаётся для
 *  коротких подсказок в одну мысль.
 *
 *  Крестик не прячет подсказку сразу, а спрашивает — навсегда или до
 *  перезагрузки. Раньше выбора не было: единственное нажатие означало
 *  «больше никогда», и человек, которому подсказка мешала прямо сейчас, либо
 *  терял её навсегда, либо терпел.
 *
 *  Спрашиваем прямо в карточке, а не отдельным окном: подсказка сама по себе
 *  мелкая, и модальное окно поверх неё — несоразмерный ответ на закрытие
 *  совета. Повторное нажатие крестика отменяет вопрос. */
export function Hint({
  id,
  title,
  items,
  className = '',
  children,
}: {
  id: string;
  title?: string;
  items?: HintItem[];
  className?: string;
  children?: ReactNode;
}) {
  const { visible, dismiss } = useHint(id);
  const [asking, setAsking] = useState(false);
  if (!visible) return null;
  return (
    <div
      className={`animate-fade-in rounded-lh-card border border-lh-accent-border bg-lh-surface px-3.5 py-3 text-xs leading-snug ${className}`}
    >
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-lh-accent-dim text-lh-accent">
          <Lightbulb size={ICON.inline} />
        </span>
        <span className="min-w-0 flex-1 font-semibold tracking-tight text-lh-text-primary">
          {title ?? t('Подсказка')}
        </span>
        <button
          type="button"
          onClick={() => setAsking((v) => !v)}
          aria-expanded={asking}
          aria-label={asking ? t('Отменить скрытие') : t('Скрыть подсказку')}
          // Крестик оставляем визуально мелким (15px иконка, итог 23.5px) —
          // крупная кнопка спорила бы с заголовком подсказки. Промах лечим
          // невидимой зоной 44x44: она вылезает на 10.25px в стороны, но у
          // карточки подсказки нет overflow:hidden и запас до её края ~1.4px,
          // так что зона не срезается. Соседи в строке — только текст, у них
          // тап перехватывать нечего.
          className={`-m-1 shrink-0 p-1 text-lh-text-secondary active:opacity-60 ${HIT_SLOP_44}`}
        >
          <X size={ICON.inline} />
        </button>
      </div>
      {items && items.length > 0 && (
        <ul className="mt-2.5 space-y-2">
          {items.map((it, i) => {
            const Icon = it.icon;
            return (
              <li key={i} className="flex items-start gap-2.5">
                <Icon size={ICON.inline} className="mt-0.5 shrink-0 text-lh-accent/80" />
                <span className="min-w-0 flex-1 text-lh-text-primary/85">{it.text}</span>
              </li>
            );
          })}
        </ul>
      )}
      {children && <div className="mt-1.5 pl-8 text-lh-text-primary/85">{children}</div>}

      {asking && (
        <div className="mt-3 border-t border-lh-border pt-2.5">
          <p className="text-xs text-lh-text-secondary">{t('Скрыть подсказку')}:</p>
          {/* Столбиком на узких экранах: два варианта в ряд на 320px дают по
              123px, а «Только до перезагрузки» требует заметно больше — текст
              обрезался бы ровно там, где различие между вариантами. */}
          <div className="mt-2 flex flex-col gap-2 min-[380px]:flex-row">
            <button
              type="button"
              onClick={() => dismiss('forever')}
              className="min-h-11 flex-1 rounded-lh-btn border border-lh-accent-border bg-lh-accent-dim px-3 py-2 text-xs font-medium text-lh-accent active:opacity-70"
            >
              {t('Больше не показывать')}
            </button>
            <button
              type="button"
              onClick={() => dismiss('session')}
              className="min-h-11 flex-1 rounded-lh-btn border border-lh-border bg-lh-surface-2 px-3 py-2 text-xs text-lh-text-secondary active:opacity-70"
            >
              {t('Только сейчас')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
