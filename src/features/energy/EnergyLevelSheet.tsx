import { Sheet } from '../../components/ui/Sheet';
import { formatDueDate } from '../../lib/dates';
import { ENERGY_LABEL, ENERGY_LEVELS } from '../../lib/energy';
import { clearEnergyLevel, setEnergyLevel } from './energyRepo';
import type { EnergyLevel } from '../../db/types';
import { t } from '../../lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  date: string | null;
  current: EnergyLevel | null;
}

/** Отметка за конкретный день — отсюда дозаполняются пропущенные дни.
 *  Шкала показана списком с якорями: на прошлой неделе уже не вспомнить,
 *  что означала «четвёрка», если подписи нет. */
export function EnergyLevelSheet({ open, onClose, date, current }: Props) {
  const choose = async (level: EnergyLevel) => {
    if (!date) return;
    await setEnergyLevel(date, level);
    onClose();
  };

  const clear = async () => {
    if (!date) return;
    await clearEnergyLevel(date);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title={date ? formatDueDate(date) : ''}>
      <div className="space-y-2">
        {ENERGY_LEVELS.map((n) => {
          const active = current === n;
          return (
            <button
              key={n}
              type="button"
              aria-pressed={active}
              onClick={() => void choose(n)}
              className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left active:opacity-70 ${
                active ? 'bg-lh-accent-dim ring-1 ring-lh-accent' : 'bg-lh-surface-2'
              }`}
            >
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                  active ? 'bg-lh-accent text-lh-bg' : 'bg-lh-surface text-lh-text-secondary'
                }`}
              >
                {n}
              </span>
              <span className={active ? 'font-medium' : ''}>{t(ENERGY_LABEL[n])}</span>
            </button>
          );
        })}
        {current !== null && (
          <button
            type="button"
            onClick={() => void clear()}
            className="min-h-11 w-full rounded-xl px-3 py-2.5 text-sm text-lh-text-secondary active:opacity-70"
          >
            {t('Снять отметку')}
          </button>
        )}
      </div>
    </Sheet>
  );
}
