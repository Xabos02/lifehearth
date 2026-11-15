import type { ReactNode } from 'react';
import { HIT_SLOP_44 } from './hitSlop';
import { Haptic } from './Haptic';

interface Props {
  active?: boolean;
  onClick?: () => void;
  /** Тап сейчас ничего не меняет (выбранный вариант единственного выбора) или
   *  ведёт в шторку — накладка пропускает его, щелчка нет (PROTOCOL §6.4).
   *  Чипам-переключателям не нужен: повторный тап у них снимает выбор. */
  hapticOff?: boolean;
  children: ReactNode;
}

export function Chip({ active = false, onClick, hapticOff, children }: Props) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors active:scale-95 ${HIT_SLOP_44} ${
        active
          ? // Сплошная заливка, а не подложка того же цвета: акцентный текст на
            // акцентной подложке упирается в 3.3:1 и выше не поднимается —
            // фон подтягивается к цвету текста, сколько его ни ослабляй.
            // Заодно выбранный фильтр теперь видно с одного взгляда.
            'border-lh-accent bg-lh-accent text-lh-bg'
          : 'border-lh-border bg-lh-surface text-lh-text-secondary'
      }`}
    >
      {children}
      {/* Чип выбора щёлкает, как сегмент (§6.4). */}
      {onClick && <Haptic off={hapticOff} />}
    </button>
  );
}

/** Горизонтальная прокручиваемая полоса чипов. */
export function ChipRow({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {children}
    </div>
  );
}
