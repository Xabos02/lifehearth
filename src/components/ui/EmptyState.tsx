import type { LucideIcon } from 'lucide-react';
/** Тоньше базового STROKE: на 40px знак пустоты должен шептать, а не звать. */
const STROKE_THIN = 1.25;

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
      {/* Знак без плитки и тонким штрихом — как на макетах: пустота тихая,
          золото остаётся за действием, а не за отсутствием данных. */}
      <Icon size={40} strokeWidth={STROKE_THIN} className="text-lh-text-secondary" aria-hidden />
      <p className="mt-5 text-[15px] text-lh-text-secondary">{title}</p>
      {hint && <p className="mt-2 max-w-64 text-[13px] leading-relaxed text-lh-text-secondary">{hint}</p>}
    </div>
  );
}
