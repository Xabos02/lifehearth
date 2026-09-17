import { useRef, useState, type ChangeEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  GTrash as Trash2,
} from '../../components/ui/glyphs';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { Sheet } from '../../components/ui/Sheet';
import { db } from '../../db/db';
import { alive, create, remove } from '../../db/repo';
import type { SavingsGoal } from '../../db/types';
import { formatRub } from '../../lib/finance';
import { goalSaved } from '../../lib/savings';
import { formatRu, todayKey } from '../../lib/dates';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

interface Props {
  open: boolean;
  onClose: () => void;
  goal: SavingsGoal | null;
}

export function DepositSheet({ open, onClose, goal }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={goal ? t('Пополнить · {title}', { title: goal.title }) : t('Пополнить')}>
      {goal && <DepositForm key={goal.id} goal={goal} onClose={onClose} />}
    </Sheet>
  );
}

function DepositForm({ goal, onClose }: { goal: SavingsGoal; onClose: () => void }) {
  const [mode, setMode] = useState<'in' | 'out'>('in');
  const [amountStr, setAmountStr] = useState('');
  const [date, setDate] = useState(todayKey());
  const [note, setNote] = useState('');

  const rows = useLiveQuery(
    () => db.savingsDeposits.where('goalId').equals(goal.id).toArray(),
    [goal.id],
  );
  const deposits = alive(rows ?? []).sort((a, b) =>
    `${b.date}${b.createdAt}`.localeCompare(`${a.date}${a.createdAt}`),
  );
  const saved = goalSaved(goal.id, deposits);

  const amount = Math.max(0, parseFloat(amountStr.replace(',', '.')) || 0);
  // Снять больше накопленного нельзя: копилка уходила в минус, «осталось»
  // становилось больше самой цели.
  const canSave = amount > 0 && (mode === 'in' || amount <= saved);
  const savingRef = useRef(false);

  const handleAdd = async () => {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    try {
      const signed = mode === 'out' ? -amount : amount;
      await create(db.savingsDeposits, {
        goalId: goal.id,
        amount: signed,
        date: date || todayKey(),
        note: note.trim(),
      });
      setAmountStr('');
      setNote('');
    } finally {
      savingRef.current = false;
    }
  };

  return (
    <div className="space-y-4 pb-2">
      <div className="rounded-2xl bg-surface-2 p-4 text-center">
        <p className="text-sm text-muted">{t('Накоплено')}</p>
        <p className="text-2xl font-bold tabular-nums" style={{ color: goal.color }}>
          {formatRub(saved)}
        </p>
        <p className="text-sm text-muted">{t('из')} {formatRub(goal.targetAmount)}</p>
      </div>

      <Field label={t('Тип')}>
        <SegmentedControl<'in' | 'out'>
          options={[
            { value: 'in', label: t('Пополнить') },
            { value: 'out', label: t('Снять') },
          ]}
          value={mode}
          onChange={setMode}
        />
      </Field>
      <Field label={t('Сумма, ₽')}>
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          value={amountStr}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setAmountStr(e.target.value)}
          placeholder="0"
        />
      </Field>
      <Field label={t('Дата')}>
        <Input
          type="date"
          value={date}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDate(e.target.value)}
        />
      </Field>
      <Field label={t('Заметка')}>
        <Input
          value={note}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setNote(e.target.value)}
          placeholder={t('Например, «премия»')}
        />
      </Field>
      <Button className="w-full" disabled={!canSave} onClick={() => void handleAdd()}>
        {mode === 'in' ? t('Пополнить') : t('Снять')}
      </Button>

      {deposits.length > 0 && (
        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">{t('История')}</span>
          <div className="card divide-y divide-hairline px-4">
            {deposits.map((d) => (
              <div key={d.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p
                    className={`font-semibold tabular-nums ${d.amount < 0 ? 'text-danger' : 'text-success'}`}
                  >
                    {d.amount < 0 ? '−' : '+'} {formatRub(Math.abs(d.amount))}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {formatRu(d.date)}
                    {d.note ? ` · ${d.note}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    // Деньги и необратимо: соседний шит на том же экране
                    // спрашивает, а этот молча стирал запись по тапу.
                    if (window.confirm('Удалить эту запись?')) void remove(db.savingsDeposits, d.id);
                  }}
                  aria-label="Удалить запись"
                  className="p-1.5 text-muted active:text-danger"
                >
                  <Trash2 size={ICON.action} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="pt-1">
        <Button variant="secondary" className="w-full" onClick={onClose}>
          Закрыть
        </Button>
      </div>
    </div>
  );
}
