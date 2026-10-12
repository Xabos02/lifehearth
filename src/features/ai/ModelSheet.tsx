import { Sheet } from '../../components/ui/Sheet';
import { MODELS, type ModelInfo } from '../../lib/ai/models';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import {
  GCheck as Check,
} from '../../components/ui/glyphs';

/** Ориентир цены «за вопрос»: типовой обмен с чтением данных — примерно
 *  6K токенов входа (история + результат инструмента) и 700 выхода.
 *  Числа честно приблизительные, поэтому подпись всегда со знаком ≈. */
function perQuestion(m: ModelInfo): string {
  const rub = (6000 * m.priceIn + 700 * m.priceOut) / 1_000_000;
  // У заглушки «бесплатно» уже в названии — дублировать подпись незачем.
  if (rub === 0) return '';
  return `≈${rub < 1 ? rub.toFixed(2) : rub.toFixed(1)} ₽ ${t('за вопрос')}`;
}

/** Человеческое «зачем эта модель», а не только цена. */
const MODEL_HINTS: Record<string, string> = {
  echo: 'Проверка интерфейса без трат — отвечает сервер приложения.',
  'anthropic/claude-sonnet-5': 'Рабочая лошадка: быстрая, умная, для повседневных вопросов.',
  'anthropic/claude-sonnet-4.6': 'Подешевле и попроще — для коротких вопросов без глубины.',
  'anthropic/claude-opus-5': 'Максимум качества для сложных разборов. Дорогая — включайте осознанно.',
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
                <p className="flex items-baseline gap-2 font-medium">
                  <span className="truncate">{t(m.label)}</span>
                  <span className={`shrink-0 font-mono text-[0.7rem] ${sub}`}>{perQuestion(m)}</span>
                </p>
                <p className={`mt-0.5 text-xs ${sub}`}>{t(MODEL_HINTS[m.id] ?? '')}</p>
              </div>
              {active && <Check size={ICON.base} className="shrink-0 text-lh-accent" />}
            </button>
          );
        })}
        <p className="px-1 pt-1 text-xs text-lh-text-secondary">
          {t('Точная стоимость каждого ответа видна под ним и в шапке чата.')}
        </p>
      </div>
    </Sheet>
  );
}
