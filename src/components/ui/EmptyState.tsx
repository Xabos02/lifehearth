import type { LucideIcon } from 'lucide-react';
import { STROKE } from './icons';

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
    <div className="flex flex-col items-center pt-14 pb-8 text-center">
      {/* Знак без плитки и обычным весом, а не акцентным: пустота тихая,
          золото остаётся за действием, а не за отсутствием данных. Вес — только
          из STROKE*: литералы веса запрещены (PROTOCOL §4.1), а нижний порог
          штриха 1.4px держит icons.spec. */}
      <Icon size={40} strokeWidth={STROKE} className="text-lh-text-secondary" aria-hidden />
      <p className="mt-5 text-[15px] text-lh-text-secondary">{title}</p>
      {hint && <p className="mt-2 max-w-64 text-[13px] leading-relaxed text-lh-text-secondary">{hint}</p>}
    </div>
  );
}
