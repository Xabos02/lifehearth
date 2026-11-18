import { Sheet } from '../../components/ui/Sheet';
import { MODELS } from '../../lib/ai/models';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import {
  GCheck as Check,
} from '../../components/ui/glyphs';

/** Человеческое «зачем эта модель», а не только цена. */
const MODEL_HINTS: Record<string, string> = {
  '@cf/google/gemma-4-26b-a4b-it': 'Бесплатно, с дневным лимитом на всех. Проще Claude, но с обычными вопросами справляется.',
  '@cf/qwen/qwen3.8-27b': 'Бесплатно и умнее Gemma, но отвечает дольше и тратит общий лимит раз в шесть быстрее.',
};

interface Props {
  open: boolean;
  value: string;
  onClose: () => void;
  onPick: (id: string) => void;
}

export function ModelSheet({ open, value, onClose, onPick }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={t('Модель')}>
      <div className="space-y-2">
        {MODELS.map((m) => {
          const active = m.id === value;
          // У выбранной подписи основным: серый на золотой подложке поверх
          // шторки — 4.40 в тёмной (канва design/muted-on-gold).
          const sub = active ? 'text-lh-text-primary' : 'text-lh-text-secondary';
          return (
            <button
              key={m.id}
              className={`flex w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors ${
                active ? 'border-lh-accent/50 bg-lh-accent-dim' : 'border-lh-border bg-lh-surface-2'
              }`}
              onClick={() => {
                onPick(m.id);
                onClose();
              }}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{t(m.label)}</p>
                <p className={`mt-0.5 text-xs ${sub}`}>{t(MODEL_HINTS[m.id] ?? '')}</p>
              </div>
              {active && <Check size={ICON.base} className="shrink-0 text-lh-accent" />}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
