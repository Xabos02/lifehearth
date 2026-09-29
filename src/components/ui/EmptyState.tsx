import type { LucideIcon } from 'lucide-react';
import { ICON, STROKE_STRONG } from './icons';

interface Props {
  icon: LucideIcon;
  title: string;
  hint?: string;
}

/** Заглушка пустого списка. Отступы асимметричны намеренно: сверху меньше —
 *  блок стоит выше геометрического центра, где глаз ищет его первым. Резерв
 *  под плавающую «+» снизу больше не нужен: лента заканчивается выше кнопки
 *  (App.tsx, --fab-strip), и накрыть подсказку кнопке нечем. */
export function EmptyState({ icon: Icon, title, hint }: Props) {
  return (
    <div className="flex flex-col items-center gap-3 pt-14 pb-8 text-center">
      <div className="card flex size-16 items-center justify-center text-lh-accent">
        <Icon size={ICON.display} strokeWidth={STROKE_STRONG} />
      </div>
      <p className="text-base font-semibold text-lh-text-primary">{title}</p>
      {hint && <p className="max-w-64 text-sm leading-relaxed text-lh-text-secondary">{hint}</p>}
    </div>
  );
}
