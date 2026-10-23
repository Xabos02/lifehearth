import { useRef, useState, type ChangeEvent } from 'react';
import { Sheet } from '../../components/ui/Sheet';
import { Chip } from '../../components/ui/Chip';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { GTrash as Trash2, GPlus } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { t } from '../../lib/i18n';
import { todayKey } from '../../lib/dates';
import type { Workout, WorkoutTemplate } from '../../db/types';
import { EFFORT_LABELS } from './workouts';
import { addWorkout, addWorkoutSession, removeWorkout, updateWorkout, type WorkoutDraft } from './workoutRepo';
import { addTemplate } from './templateRepo';
import { TemplatesSheet } from './TemplatesSheet';
import { ItemFields } from './ItemFields';
import { itemFromSaved, newItem, savedFromItem, type Item } from './workoutItem';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Запись для правки; null — новая. */
  workout: Workout | null;
  /** День по умолчанию для новой (выбранный в календаре). */
  date: string;
}

/** Форма тренировки. Обязательное — дата и вид (минуты подставляются по
 *  виду, но их можно стереть), остальное по желанию: владелец просил отмечать занятие в два
 *  касания, а не заполнять анкету.
 *
 *  Новая запись — это набор ИЗ ОДНОГО ИЛИ НЕСКОЛЬКИХ видов «в одно целое»:
 *  можно добавить ещё вид кнопкой, загрузить шаблон и убрать из него то, чего
 *  сегодня не делали. Правка уже сохранённой записи — как раньше, один вид. */
export function WorkoutSheet({ open, onClose, workout, date }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={workout ? t('Тренировка') : t('Новая тренировка')}>
      {open && <WorkoutForm key={(workout?.id ?? 'new') + date} workout={workout} date={date} onClose={onClose} />}
    </Sheet>
  );
}

function WorkoutForm({ workout, date, onClose }: { workout: Workout | null; date: string; onClose: () => void }) {
  const [day, setDay] = useState(workout?.date ?? date);
  const [items, setItems] = useState<Item[]>(() => (workout ? [itemFromSaved(workout)] : [newItem()]));
  const [effort, setEffort] = useState<Workout['effort']>(workout?.effort ?? null);
  const [note, setNote] = useState(workout?.note ?? '');
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const savingRef = useRef(false);

  // Минуты по желанию (задача 38): вид без времени — тоже тренировка.
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= todayKey();
  const canSave = validDay && items.length > 0;

  function updateItem(key: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  function applyTemplate(tpl: WorkoutTemplate) {
    setItems(tpl.items.length ? tpl.items.map(itemFromSaved) : [newItem()]);
    setTemplatesOpen(false);
  }

  async function saveAsTemplate() {
    const name = window.prompt(t('Название шаблона:'))?.trim();
    if (!name) return;
    await addTemplate(name, items.map(savedFromItem));
  }

  const save = async () => {
    if (savingRef.current || !canSave) return;
    savingRef.current = true;
    try {
      const drafts: WorkoutDraft[] = items.map((it) => ({
        ...savedFromItem(it),
        date: day,
        effort,
        note: note.trim(),
        source: workout?.source ?? ('manual' as const),
        // Правка вида оставляет его в занятии: с null исправленные минуты
        // превращали силовую + растяжку в две тренировки за месяц. Перенос
        // на другой день — уже отдельное занятие.
        groupId: workout && day === workout.date ? (workout.groupId ?? null) : null,
      }));
      if (workout) await updateWorkout(workout.id, drafts[0]);
      else if (drafts.length === 1) await addWorkout(drafts[0]);
      else await addWorkoutSession(drafts);
      onClose();
    } finally {
      savingRef.current = false;
    }
  };

  const del = async () => {
    if (!workout) return;
    if (!window.confirm(t('Удалить тренировку?'))) return;
    await removeWorkout(workout.id);
    onClose();
  };

  return (
    <div className="space-y-4 pb-2">
      <Field label={t('Когда')}>
        <Input type="date" value={day} max={todayKey()} onChange={(e: ChangeEvent<HTMLInputElement>) => setDay(e.target.value)} />
      </Field>

      {items.map((it, idx) => (
        <ItemFields
          key={it.key}
          item={it}
          index={idx}
          removable={!workout && items.length > 1}
          onRemove={() => setItems((prev) => prev.filter((x) => x.key !== it.key))}
          onChange={(patch) => updateItem(it.key, patch)}
        />
      ))}

      {!workout && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setItems((prev) => [...prev, newItem()])}
            className={`flex items-center gap-1 rounded-full border border-dashed border-lh-border-strong px-3.5 py-1.5 text-sm font-medium text-lh-accent active:opacity-70 ${HIT_SLOP_44}`}
          >
            <GPlus size={ICON.inline} /> {t('Добавить ещё вид')}
          </button>
          <button
            type="button"
            onClick={() => setTemplatesOpen(true)}
            className={`flex items-center gap-1 rounded-full border border-lh-border-strong px-3.5 py-1.5 text-sm font-medium text-lh-text-secondary active:opacity-70 ${HIT_SLOP_44}`}
          >
            {t('Из шаблона')}
          </button>
        </div>
      )}

      <div>
        <p className="mb-1.5 text-sm font-medium text-lh-text-secondary">{t('Как прошло')}</p>
        <div className="flex flex-wrap gap-2">
          {EFFORT_LABELS.map((e) => (
            <Chip key={e.value} active={effort === e.value} onClick={() => setEffort(effort === e.value ? null : e.value)}>
              {t(e.label)}
            </Chip>
          ))}
        </div>
      </div>

      <Field label={t('Заметка')}>
        <Input
          value={note}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setNote(e.target.value)}
          onClear={() => setNote('')}
          placeholder={t('Что делали, как самочувствие…')}
        />
      </Field>

      <Button className="w-full" disabled={!canSave} onClick={() => void save()}>
        {t('Сохранить')}
      </Button>
      {!workout && (
        <button
          type="button"
          onClick={() => void saveAsTemplate()}
          className={`w-full text-center text-sm font-medium text-lh-accent active:opacity-70 ${HIT_SLOP_44}`}
        >
          {t('Сделать из этого набора шаблон')}
        </button>
      )}
      {workout && (
        <button
          type="button"
          onClick={() => void del()}
          className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-lh-border-strong py-3 text-center font-medium text-danger active:opacity-70"
        >
          <Trash2 size={ICON.action} /> {t('Удалить')}
        </button>
      )}

      <TemplatesSheet open={templatesOpen} onClose={() => setTemplatesOpen(false)} onPick={applyTemplate} />
    </div>
  );
}
