import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { AutoGrowTextarea, Field, Input } from '../../components/ui/Input';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { Sheet } from '../../components/ui/Sheet';
import { db } from '../../db/db';
import { create, remove, update } from '../../db/repo';
import type { ExpenseItem, ExpenseKind, ExpenseRecurrence } from '../../db/types';
import { EXPENSE_CATEGORY_SUGGESTIONS } from '../../lib/finance';
import { t } from '../../lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  item?: ExpenseItem | null;
}

export function ExpenseSheet({ open, onClose, item }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={item ? t('Запись') : t('Новая запись')}>
      {/* Sheet при !open возвращает null → форма размонтируется и при
          следующем открытии инициализируется заново из item. */}
      <ExpenseForm key={item?.id ?? 'new'} item={item ?? null} onClose={onClose} />
    </Sheet>
  );
}

function ExpenseForm({ item, onClose }: { item: ExpenseItem | null; onClose: () => void }) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [amountStr, setAmountStr] = useState(item ? String(item.amount) : '');
  const [kind, setKind] = useState<ExpenseKind>(item?.kind ?? 'expense');
  const [category, setCategory] = useState(item?.category ?? '');
  const [recurrence, setRecurrence] = useState<ExpenseRecurrence>(item?.recurrence ?? 'monthly');
  const [dayStr, setDayStr] = useState(item?.dayOfMonth != null ? String(item.dayOfMonth) : '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [active, setActive] = useState(item?.active ?? true);

  const amount = Math.max(0, parseFloat(amountStr) || 0);
  const canSave = title.trim().length > 0 && amount > 0;

  const savingRef = useRef(false);
  const handleSave = async () => {
    if (!canSave) return;
    if (savingRef.current) return; // защита от дабл-тапа
    savingRef.current = true;
    try {
      let dayOfMonth: number | null = null;
      if (recurrence === 'monthly' && dayStr.trim()) {
        const d = parseInt(dayStr, 10);
        if (!Number.isNaN(d)) dayOfMonth = Math.max(1, Math.min(31, d));
      }
      const base = {
        title: title.trim(),
        amount,
        kind,
        category: category.trim(),
        recurrence,
        dayOfMonth,
        notes: notes.trim(),
        active,
      };
      if (item) {
        await update(db.expenseItems, item.id, base);
      } else {
        await create(db.expenseItems, { ...base, sortOrder: Date.now() });
      }
      onClose();
    } finally {
      savingRef.current = false;
    }
  };

  const handleDelete = async () => {
    if (!item) return;
    if (!window.confirm(t('Удалить запись?'))) return;
    await remove(db.expenseItems, item.id);
    onClose();
  };

  return (
    <div className="space-y-4 pb-2">
      <Field label={t('Название')}>
        <AutoGrowTextarea
          value={title}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setTitle(e.target.value)}
          onClear={() => setTitle('')}
          placeholder={t('Например, «Аренда квартиры»')}
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
      <Field label={t('Тип')}>
        <SegmentedControl<ExpenseKind>
          options={[
            { value: 'expense', label: t('Расход') },
            { value: 'income', label: t('Доход') },
          ]}
          value={kind}
          onChange={setKind}
        />
      </Field>
      {kind === 'expense' && (
        <div>
          <span className="mb-1.5 block text-sm font-medium text-lh-text-secondary">{t('Категория')}</span>
          <div className="mb-2">
            <ChipRow>
              {EXPENSE_CATEGORY_SUGGESTIONS.map((c) => (
                <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
                  {t(c)}
                </Chip>
              ))}
            </ChipRow>
          </div>
          <Input
            value={category}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setCategory(e.target.value)}
            placeholder={t('Категория')}
          />
        </div>
      )}
      <Field label={t('Периодичность')}>
        <SegmentedControl<ExpenseRecurrence>
          options={[
            { value: 'monthly', label: t('Месяц') },
            { value: 'weekly', label: t('Неделя') },
            { value: 'yearly', label: t('Год') },
            { value: 'oneoff', label: t('Разово') },
          ]}
          value={recurrence}
          onChange={setRecurrence}
        />
      </Field>
      {recurrence === 'monthly' && (
        <Field label={t('День месяца')}>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            value={dayStr}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setDayStr(e.target.value)}
            placeholder={t('Например, 5')}
          />
        </Field>
      )}
      <Field label={t('Заметки')}>
        <AutoGrowTextarea
          value={notes}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
          placeholder={t('Детали, способ оплаты…')}
          className="min-h-[4.5rem]"
        />
      </Field>
      <button
        type="button"
        onClick={() => setActive((v) => !v)}
        className={`w-full rounded-xl border px-3.5 py-3 text-left text-sm font-medium transition-colors ${
          active
            ? 'border-lh-accent bg-lh-accent-dim text-lh-accent'
            : 'border-lh-border bg-lh-surface text-lh-text-secondary'
        }`}
      >
        {active ? t('Учитывается в сводке') : t('Не учитывается в сводке')}
      </button>
      <div className="flex gap-2 pt-1">
        {item && (
          <Button variant="danger" onClick={() => void handleDelete()}>
            {t('Удалить')}
          </Button>
        )}
        <Button className="flex-1" disabled={!canSave} onClick={() => void handleSave()}>
          {t('Сохранить')}
        </Button>
      </div>
    </div>
  );
}
