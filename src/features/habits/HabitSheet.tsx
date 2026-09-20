import { useRef, useState, type ChangeEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { AutoGrowTextarea, Field, Input } from '../../components/ui/Input';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { Sheet } from '../../components/ui/Sheet';
import { db } from '../../db/db';
import { create, now, remove, update } from '../../db/repo';
import { PRESET_COLORS } from '../../lib/colors';
import { WEEKDAY_LABELS } from '../../lib/dates';
import { isFrozenNow } from '../../lib/habits';
import { t } from '../../lib/i18n';
import { freezeHabit, unfreezeHabit } from './habitRepo';
import type { Habit, HabitSchedule } from '../../db/types';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';

type SchedType = 'daily' | 'weekdays';
type Mode = 'check' | 'count';

interface Props {
  open: boolean;
  onClose: () => void;
  item?: Habit | null;
}

export function HabitSheet({ open, onClose, item }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={item ? t('Привычка') : t('Новая привычка')}>
      {/* Sheet при !open размонтирует содержимое → форма всегда инициализируется
          заново из item (key меняется). */}
      <HabitForm key={item?.id ?? 'new'} item={item ?? null} onClose={onClose} />
    </Sheet>
  );
}

function HabitForm({ item, onClose }: { item: Habit | null; onClose: () => void }) {
  const [name, setName] = useState(item?.name ?? '');
  const [emoji, setEmoji] = useState(item?.emoji ?? '✅');
  const [color, setColor] = useState(item?.color ?? PRESET_COLORS[0]);
  const [schedType, setSchedType] = useState<SchedType>(
    item?.schedule.type === 'weekdays' ? 'weekdays' : 'daily',
  );
  const [weekdays, setWeekdays] = useState<number[]>(
    item?.schedule.type === 'weekdays' ? item.schedule.weekdays : [1, 2, 3, 4, 5, 6, 7],
  );
  const [mode, setMode] = useState<Mode>(item?.target != null ? 'count' : 'check');
  const [targetRaw, setTargetRaw] = useState(item?.target != null ? String(item.target) : '');
  const [unit, setUnit] = useState(item?.unit ?? '');

  const toggleDay = (d: number) =>
    setWeekdays((w) =>
      w.includes(d) ? w.filter((x) => x !== d) : [...w, d].sort((a, b) => a - b),
    );

  const targetNum = Number(targetRaw) || 0;
  const valid =
    Boolean(name.trim()) &&
    (schedType === 'daily' || weekdays.length > 0) &&
    (mode === 'check' || targetNum > 0);

  const savingRef = useRef(false);
  const handleSave = async () => {
    if (!valid) return;
    if (savingRef.current) return; // защита от дабл-тапа
    savingRef.current = true;
    try {
      const schedule: HabitSchedule =
        schedType === 'daily' ? { type: 'daily' } : { type: 'weekdays', weekdays };
      const base = {
        name: name.trim(),
        emoji: emoji.trim() || '✅',
        color,
        schedule,
        target: mode === 'count' ? targetNum : null,
        unit: mode === 'count' ? unit.trim() : '',
      };
      if (item) {
        await update(db.habits, item.id, base);
      } else {
        await create(db.habits, {
          ...base,
          goalId: null,
          archivedAt: null,
          sortOrder: Date.now(),
        });
      }
      onClose();
    } finally {
      savingRef.current = false;
    }
  };

  const handleArchive = async () => {
    if (!item) return;
    await update(db.habits, item.id, { archivedAt: item.archivedAt ? null : now() });
    onClose();
  };

  // Заморозка — «осознанно отложить без чувства вины», тот же концепт, что и
  // у задач: серия перестаёт планироваться на эти дни и потому не рвётся.
  // Никаких дат-пикеров: интервал открывается сегодняшним днём и закрывается
  // при следующей разморозке — минимализм важнее гибкости здесь.
  const frozen = item ? isFrozenNow(item) : false;
  const handleFreeze = async () => {
    if (!item) return;
    if (frozen) await unfreezeHabit(item.id);
    else await freezeHabit(item.id, 'manual');
    onClose();
  };

  const handleDelete = async () => {
    if (!item) return;
    if (!window.confirm(t('Удалить привычку? История отметок тоже скроется.'))) return;
    await remove(db.habits, item.id);
    onClose();
  };

  return (
    <div className="space-y-4 pb-2">
      <Field label={t('Название')}>
        <AutoGrowTextarea
          value={name}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setName(e.target.value)}
          onClear={() => setName('')}
          placeholder={t('Например, «Отжимания»')}
        />
      </Field>

      <Field label={t('Эмодзи')}>
        <Input
          value={emoji}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEmoji(e.target.value)}
        />
      </Field>

      <Field label={t('Как отмечать')}>
        <SegmentedControl<Mode>
          options={[
            { value: 'check', label: t('Галочка') },
            { value: 'count', label: t('Счётчик') },
          ]}
          value={mode}
          onChange={setMode}
        />
      </Field>

      {mode === 'count' && (
        <>
          <Field label={t('Цель за день')}>
            <Input
              inputMode="decimal"
              value={targetRaw}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTargetRaw(e.target.value)}
              placeholder={t('Например, 30')}
            />
          </Field>
          <Field label={t('Единица')}>
            <Input
              value={unit}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setUnit(e.target.value)}
              placeholder={t('раз, км, л, мин…')}
            />
          </Field>
        </>
      )}

      <Field label={t('Как часто')}>
        <SegmentedControl<SchedType>
          options={[
            { value: 'daily', label: t('Каждый день') },
            { value: 'weekdays', label: t('По дням недели') },
          ]}
          value={schedType}
          onChange={setSchedType}
        />
      </Field>

      {schedType === 'weekdays' && (
        <div className="flex flex-wrap gap-2">
          {WEEKDAY_LABELS.map((label, i) => {
            const d = i + 1; // 1=Пн … 7=Вс
            const active = weekdays.includes(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => toggleDay(d)}
                className={`size-10 rounded-full border text-sm font-medium transition-colors ${HIT_SLOP_44} ${
                  active
                    ? 'border-transparent bg-accent-fill text-white'
                    : 'border-hairline bg-surface-2 text-muted'
                }`}
              >
                {t(label)}
              </button>
            );
          })}
        </div>
      )}

      <div>
        <span className="mb-1.5 block text-sm font-medium text-muted">{t('Цвет')}</span>
        <div className="flex flex-wrap gap-2.5">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={t('Цвет {c}', { c })}
              onClick={() => setColor(c)}
              className={`size-9 rounded-full border-2 transition-colors ${HIT_SLOP_44} ${
                color === c ? 'border-text' : 'border-transparent'
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>

      {item && (
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={() => void handleFreeze()}>
            {frozen ? t('Разморозить') : t('Заморозить')}
          </Button>
          <Button variant="secondary" className="flex-1" onClick={() => void handleArchive()}>
            {item.archivedAt ? t('Вернуть из архива') : t('В архив')}
          </Button>
        </div>
      )}

      <div className="flex gap-2">
        {item && (
          <Button variant="danger" onClick={() => void handleDelete()}>
            {t('Удалить')}
          </Button>
        )}
        <Button className="flex-1" disabled={!valid} onClick={() => void handleSave()}>
          {t('Сохранить')}
        </Button>
      </div>
    </div>
  );
}
