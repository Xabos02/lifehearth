import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { ProgressRing } from '../../components/ui/ProgressRing';
import { Sheet } from '../../components/ui/Sheet';
import { t } from '../../lib/i18n';
import { setHabitValue } from './habitRepo';
import type { Habit } from '../../db/types';

interface Props {
  open: boolean;
  onClose: () => void;
  habit: Habit | null;
  date: string;
  currentValue: number;
}

/** Ввод значения количественной привычки за день (счётчик: 30 раз, 5 км…). */
export function HabitLogSheet({ open, onClose, habit, date, currentValue }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={habit?.name ?? ''}>
      {habit && (
        <LogForm
          key={habit.id + date + currentValue}
          habit={habit}
          date={date}
          currentValue={currentValue}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

function LogForm({
  habit,
  date,
  currentValue,
  onClose,
}: {
  habit: Habit;
  date: string;
  currentValue: number;
  onClose: () => void;
}) {
  // raw-строка, а не number — иначе контролируемый number-инпут ломает ввод «5.» → «5».
  const [raw, setRaw] = useState(currentValue ? String(currentValue) : '');
  // Синхронное зеркало актуального значения: «Сохранить» читает его напрямую,
  // не дожидаясь ре-рендера (иначе быстрый тап «Сохранить» сразу после ввода
  // сохранил бы прежнее значение из замыкания).
  const rawRef = useRef(raw);
  const set = (v: string) => {
    rawRef.current = v;
    setRaw(v);
  };

  const val = Number(raw.replace(',', '.')) || 0;
  const target = habit.target ?? 0;
  const pct = target > 0 ? Math.min(100, (val / target) * 100) : 0;

  const save = async () => {
    // «7,5» с русской клавиатуры: запятая — это точка, а не ноль (ноль снимал отметку дня).
    await setHabitValue(habit.id, date, Number(rawRef.current.replace(',', '.')) || 0);
    onClose();
  };

  return (
    <div className="space-y-4 pb-2">
      <div className="flex justify-center pt-1">
        <ProgressRing
          value={pct}
          size={104}
          strokeWidth={8}
          color={habit.color}
          label={`${val}/${target}`}
        />
      </div>
      <Field
        label={
          habit.unit
            ? t('Сколько сегодня ({unit})', { unit: habit.unit })
            : t('Сколько сегодня')
        }
      >
        <Input
          inputMode="decimal"
          value={raw}
          onChange={(e: ChangeEvent<HTMLInputElement>) => set(e.target.value)}
          onClear={() => set('')}
          placeholder="0"
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        {[1, 5, 10].map((inc) => (
          <Button
            key={inc}
            variant="secondary"
            onClick={() => set(String((Number(rawRef.current.replace(',', '.')) || 0) + inc))}
          >
            +{inc}
          </Button>
        ))}
        <Button variant="secondary" onClick={() => set(String(target))}>
          {t('= цель')}
        </Button>
        <Button variant="secondary" onClick={() => set('')}>
          {t('Сброс')}
        </Button>
      </div>
      <Button className="w-full" onClick={() => void save()}>
        {t('Сохранить')}
      </Button>
    </div>
  );
}
