import { useRef, useState, type ChangeEvent } from 'react';
import {
  GCheck as Check,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { alive, create, remove, update } from '../../db/repo';
import type { Goal, GoalProgressMode, GoalStatus } from '../../db/types';
import { PRESET_COLORS, isLightColor, ON_COLOR_DARK } from '../../lib/colors';
import { t } from '../../lib/i18n';
import { Button } from '../../components/ui/Button';
import { AutoGrowTextarea, Field, Input } from '../../components/ui/Input';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { Sheet } from '../../components/ui/Sheet';
import { ICON, STROKE_HEAVY } from '../../components/ui/icons';
import { confirmAction } from '../../components/ui/confirmStore';

const MODE_OPTIONS: { value: GoalProgressMode; label: string }[] = [
  { value: 'manual', label: 'Вручную' },
  { value: 'tasks', label: 'По задачам' },
  { value: 'numeric', label: 'Числовой' },
];

const STATUS_OPTIONS: { value: GoalStatus; label: string }[] = [
  { value: 'active', label: 'Активна' },
  { value: 'paused', label: 'Пауза' },
  { value: 'completed', label: 'Завершена' },
  { value: 'archived', label: 'Архив' },
];

/** Шит создания/редактирования цели. goal=null|undefined — создание. */
export function GoalEditSheet({
  open,
  onClose,
  goal,
}: {
  open: boolean;
  onClose: () => void;
  goal?: Goal | null;
}) {
  // Форма монтируется заново на каждое открытие (и при смене цели —
  // через key): состояние берётся из props, сброс эффектом не нужен.
  if (!open) return null;
  return <GoalEditForm key={goal?.id ?? 'new'} onClose={onClose} goal={goal} />;
}

function GoalEditForm({
  onClose,
  goal,
}: {
  onClose: () => void;
  goal?: Goal | null;
}) {
  const [title, setTitle] = useState(goal?.title ?? '');
  const [description, setDescription] = useState(goal?.description ?? '');
  const [color, setColor] = useState(goal?.color ?? PRESET_COLORS[0]);
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '');
  const [mode, setMode] = useState<GoalProgressMode>(goal?.progressMode ?? 'manual');
  const [targetValue, setTargetValue] = useState(
    goal?.targetValue != null ? String(goal.targetValue) : '',
  );
  const [unitLabel, setUnitLabel] = useState(goal?.unitLabel ?? '');
  const [status, setStatus] = useState<GoalStatus>(goal?.status ?? 'active');

  const savingRef = useRef(false);
  async function handleSave() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    if (savingRef.current) return; // защита от дабл-тапа
    savingRef.current = true;
    try {
      const tvRaw = targetValue.trim() === '' ? NaN : Number(targetValue);
      const data = {
        title: trimmedTitle,
        description: description.trim(),
        color,
        targetDate: targetDate || null,
        progressMode: mode,
        targetValue: Number.isFinite(tvRaw) && tvRaw > 0 ? tvRaw : null,
        unitLabel: unitLabel.trim(),
      };
      if (goal) {
        await update(db.goals, goal.id, { ...data, status });
      } else {
        await create(db.goals, {
          ...data,
          status: 'active',
          progressManual: 0,
          currentValue: mode === 'numeric' ? 0 : null,
          sortOrder: Date.now(),
        });
      }
      onClose();
    } finally {
      savingRef.current = false;
    }
  }

  async function handleDelete() {
    if (!goal) return;
    if (!(await confirmAction(t('Удалить цель «{title}»?', { title: goal.title })))) return;
    const [tasks, items] = await Promise.all([
      db.tasks.where('goalId').equals(goal.id).toArray(),
      db.learningItems.where('goalId').equals(goal.id).toArray(),
    ]);
    await Promise.all([
      ...alive(tasks).map((task) => update(db.tasks, task.id, { goalId: null })),
      ...alive(items).map((li) => update(db.learningItems, li.id, { goalId: null })),
      remove(db.goals, goal.id),
    ]);
    onClose();
  }

  return (
    <Sheet open onClose={onClose} title={goal ? t('Редактировать цель') : t('Новая цель')}>
      <div className="flex flex-col gap-4 pb-2">
        <Field label={t('Название')}>
          <AutoGrowTextarea
            value={title}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setTitle(e.target.value)}
            onClear={() => setTitle('')}
            placeholder={t('Например, Прочитать 20 книг')}
          />
        </Field>

        <Field label={t('Описание')}>
          <AutoGrowTextarea
            value={description}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
            placeholder={t('Зачем эта цель и что считается результатом')}
            className="min-h-[4.5rem]"
          />
        </Field>

        <Field label={t('Цвет')}>
          <div className="flex flex-wrap gap-2.5">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={t('Цвет {c}', { c })}
                onClick={() => setColor(c)}
                className="flex size-9 items-center justify-center rounded-full"
                style={{ background: c }}
              >
                {color === c && (
                  <Check size={ICON.base} color={isLightColor(c) ? ON_COLOR_DARK : '#fff'} strokeWidth={STROKE_HEAVY} />
                )}
              </button>
            ))}
          </div>
        </Field>

        <Field label={t('Срок')}>
          <Input
            type="date"
            value={targetDate}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setTargetDate(e.target.value)}
          />
        </Field>

        <Field label={t('Прогресс')}>
          <SegmentedControl
            options={MODE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
            value={mode}
            onChange={setMode}
          />
        </Field>

        {mode === 'numeric' && (
          <div className="flex gap-3">
            <div className="flex-1">
              <Field label={t('Целевое значение')}>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={targetValue}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setTargetValue(e.target.value)}
                  placeholder="20"
                />
              </Field>
            </div>
            <div className="flex-1">
              <Field label={t('Единицы')}>
                <Input
                  value={unitLabel}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setUnitLabel(e.target.value)}
                  placeholder={t('книг')}
                />
              </Field>
            </div>
          </div>
        )}

        {goal && (
          <Field label={t('Статус')}>
            <SegmentedControl
              options={STATUS_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
              value={status}
              onChange={setStatus}
            />
          </Field>
        )}

        <div className="mt-1 flex flex-col gap-2">
          <Button
            onClick={handleSave}
            disabled={!title.trim() || (mode === 'numeric' && !(Number(targetValue) > 0))}
          >
            {t('Сохранить')}
          </Button>
          {goal && (
            <Button variant="danger" onClick={handleDelete}>
              {t('Удалить')}
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
