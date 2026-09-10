import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { Sheet } from '../../components/ui/Sheet';
import type { LearningItem } from '../../db/types';
import { formatDuration } from '../../lib/duration';
import { t } from '../../lib/i18n';
import { logSession } from './session';

/** Быстрые кнопки. Своё время вводят редко — почти всегда занятие
 *  укладывается в одну из этих четырёх длительностей. */
const QUICK = [30, 60, 120, 180];

interface Props {
  open: boolean;
  onClose: () => void;
  item: LearningItem;
}

export function LogSessionSheet({ open, onClose, item }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={t('Сколько занимался?')}>
      <SessionForm key={item.id} item={item} onClose={onClose} />
    </Sheet>
  );
}

function SessionForm({ item, onClose }: { item: LearningItem; onClose: () => void }) {
  const [minutes, setMinutes] = useState<number | null>(null);
  const [customStr, setCustomStr] = useState('');
  const [note, setNote] = useState('');
  const savingRef = useRef(false);

  const custom = Math.round(Number(customStr.replace(',', '.')) * 60);
  // Своё время побеждает кнопку: если человек начал вводить руками, значит
  // ни одна из четырёх не подошла.
  const total = customStr.trim() && custom > 0 ? custom : minutes;

  const handleSave = async () => {
    if (!total || total <= 0) return;
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await logSession(item, total, note);
      onClose();
    } finally {
      savingRef.current = false;
    }
  };

  return (
    <div className="space-y-4 pb-2">
      <div className="flex gap-2">
        {QUICK.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={total === m}
            onClick={() => {
              setMinutes(m);
              setCustomStr('');
            }}
            className={`h-11 flex-1 rounded-xl text-base font-semibold tabular-nums transition-all duration-200 ${
              total === m
                ? 'bg-accent-fill text-white shadow-[0_2px_10px_-3px_var(--app-accent-fill)]'
                : 'bg-surface-2 text-muted active:text-text'
            }`}
          >
            {formatDuration(m)}
          </button>
        ))}
      </div>

      <Field label={t('Или своё время, часов')}>
        <Input
          type="number"
          inputMode="decimal"
          step="0.25"
          min={0}
          value={customStr}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setCustomStr(e.target.value)}
          placeholder={t('Например, 2,5')}
        />
      </Field>

      <Field label={t('Над чем работал')}>
        <Input
          value={note}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setNote(e.target.value)}
          placeholder={t('Необязательно')}
        />
      </Field>

      <Button className="w-full" disabled={!total || total <= 0} onClick={() => void handleSave()}>
        {total && total > 0
          ? t('Записать {time}', { time: formatDuration(total) })
          : t('Записать')}
      </Button>
    </div>
  );
}
