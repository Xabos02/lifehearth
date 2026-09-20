import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { AutoGrowTextarea, Field, Input } from '../../components/ui/Input';
import { Sheet } from '../../components/ui/Sheet';
import { db } from '../../db/db';
import { create, remove, update } from '../../db/repo';
import { t } from '../../lib/i18n';
import type { SavingsGoal } from '../../db/types';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';

const COLORS = ['#7c9cff', '#a78bfa', '#f472b6', '#fb923c', '#facc15', '#4ade80', '#22d3ee', '#f87171'];

interface Props {
  open: boolean;
  onClose: () => void;
  goal?: SavingsGoal | null;
}

export function SavingsGoalSheet({ open, onClose, goal }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={goal ? t('Цель накопления') : t('Новая цель')}>
      <GoalForm key={goal?.id ?? 'new'} goal={goal ?? null} onClose={onClose} />
    </Sheet>
  );
}

function GoalForm({ goal, onClose }: { goal: SavingsGoal | null; onClose: () => void }) {
  const [title, setTitle] = useState(goal?.title ?? '');
  const [emoji, setEmoji] = useState(goal?.emoji ?? '🎯');
  const [color, setColor] = useState(goal?.color ?? COLORS[0]);
  const [amountStr, setAmountStr] = useState(goal ? String(goal.targetAmount) : '');
  const [date, setDate] = useState(goal?.targetDate ?? '');
  const [note, setNote] = useState(goal?.note ?? '');

  const targetAmount = Math.max(0, parseFloat(amountStr) || 0);
  const canSave = title.trim().length > 0 && targetAmount > 0;
  const savingRef = useRef(false);

  const handleSave = async () => {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    try {
      const base = {
        title: title.trim(),
        emoji: emoji.trim() || '🎯',
        color,
        targetAmount,
        targetDate: date || null,
        note: note.trim(),
      };
      if (goal) await update(db.savingsGoals, goal.id, base);
      else await create(db.savingsGoals, { ...base, archivedAt: null, sortOrder: Date.now() });
      onClose();
    } finally {
      savingRef.current = false;
    }
  };

  const handleDelete = async () => {
    if (!goal) return;
    if (!window.confirm(t('Удалить цель со всеми пополнениями?'))) return;
    const deps = await db.savingsDeposits.where('goalId').equals(goal.id).toArray();
    for (const d of deps) await remove(db.savingsDeposits, d.id);
    await remove(db.savingsGoals, goal.id);
    onClose();
  };

  return (
    <div className="space-y-4 pb-2">
      <Field label={t('Название')}>
        <AutoGrowTextarea
          value={title}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setTitle(e.target.value)}
          placeholder={t('Например, «Подушка безопасности»')}
        />
      </Field>
      <div className="flex gap-3">
        <div className="w-24">
          <Field label={t('Значок')}>
            <Input
              value={emoji}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEmoji(e.target.value)}
              maxLength={2}
              className="text-center text-lg"
            />
          </Field>
        </div>
        <div className="flex-1">
          <Field label={t('Цель, ₽')}>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              value={amountStr}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setAmountStr(e.target.value)}
              placeholder="0"
            />
          </Field>
        </div>
      </div>
      <div>
        <span className="mb-1.5 block text-sm font-medium text-muted">{t('Цвет')}</span>
        <div className="flex flex-wrap gap-2.5">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={t('Цвет {c}', { c })}
              className={`size-8 rounded-full transition-transform ${HIT_SLOP_44} ${
                color === c ? 'scale-110 ring-2 ring-white/70' : ''
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>
      <Field label={t('Срок')}>
        <Input
          type="date"
          value={date}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDate(e.target.value)}
        />
      </Field>
      <Field label={t('Заметка')}>
        <AutoGrowTextarea
          value={note}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)}
          placeholder={t('Зачем копим, детали…')}
          className="min-h-[4rem]"
        />
      </Field>
      <div className="flex gap-2 pt-1">
        {goal && (
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
