import { useRef, useState, type ChangeEvent } from 'react';
import { Sheet } from '../../components/ui/Sheet';
import { Chip } from '../../components/ui/Chip';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { GTrash as Trash2 } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { t } from '../../lib/i18n';
import { todayKey } from '../../lib/dates';
import type { Workout, WorkoutType } from '../../db/types';
import { EFFORT_LABELS, WORKOUT_KINDS, workoutKind } from './workouts';
import { addWorkout, removeWorkout, updateWorkout } from './workoutRepo';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Запись для правки; null — новая. */
  workout: Workout | null;
  /** День по умолчанию для новой (выбранный в календаре). */
  date: string;
}

/** Форма тренировки. Обязательное — вид и минуты (минуты подставляются по
 *  виду), остальное по желанию: владелец просил отмечать занятие в два
 *  касания, а не заполнять анкету. */
export function WorkoutSheet({ open, onClose, workout, date }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={workout ? t('Тренировка') : t('Новая тренировка')}>
      {open && <WorkoutForm key={(workout?.id ?? 'new') + date} workout={workout} date={date} onClose={onClose} />}
    </Sheet>
  );
}

function WorkoutForm({ workout, date, onClose }: { workout: Workout | null; date: string; onClose: () => void }) {
  const [type, setType] = useState<WorkoutType>(workout?.type ?? 'run');
  const [day, setDay] = useState(workout?.date ?? date);
  // Строки, а не числа: контролируемый number-инпут ломает ввод «5.» → «5».
  const [minutes, setMinutes] = useState(String(workout?.minutes ?? workoutKind(type).defaultMinutes));
  const [distance, setDistance] = useState(workout?.distanceKm != null ? String(workout.distanceKm) : '');
  const [effort, setEffort] = useState<Workout['effort']>(workout?.effort ?? null);
  const [note, setNote] = useState(workout?.note ?? '');
  const [minutesTouched, setMinutesTouched] = useState(Boolean(workout));

  const kind = workoutKind(type);
  const minutesNum = Math.round(Number(minutes.replace(',', '.')) || 0);
  const canSave = minutesNum > 0 && /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= todayKey();
  // Защита от дабл-тапа: второй тап по «Сохранить» до конца записи давал две
  // одинаковые тренировки — две точки в ячейке и +2 к счётчику.
  const savingRef = useRef(false);

  const pickType = (next: WorkoutType) => {
    setType(next);
    // Минуты по умолчанию следуют за видом, пока человек их не трогал сам.
    if (!minutesTouched) setMinutes(String(workoutKind(next).defaultMinutes));
  };

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const dist = kind.hasDistance ? Number(distance.replace(',', '.')) : 0;
      const draft = {
        date: day,
        type,
        minutes: minutesNum,
        distanceKm: kind.hasDistance && dist > 0 ? Math.round(dist * 100) / 100 : null,
        effort,
        note: note.trim(),
        source: workout?.source ?? ('manual' as const),
      };
      if (workout) await updateWorkout(workout.id, draft);
      else await addWorkout(draft);
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
      <div>
        <p className="mb-1.5 text-sm font-medium text-muted">{t('Вид')}</p>
        {/* Перенос, а не прокрутка: вид — единственное обязательное поле, а в
            ряду с прокруткой пять из девяти уезжали за край экрана. */}
        <div className="flex flex-wrap gap-2">
          {WORKOUT_KINDS.map((k) => (
            <Chip key={k.value} active={type === k.value} onClick={() => pickType(k.value)}>
              {t(k.label)}
            </Chip>
          ))}
        </div>
      </div>

      <div className="flex gap-3">
        <Field label={t('Когда')} className="flex-1">
          <Input type="date" value={day} max={todayKey()} onChange={(e: ChangeEvent<HTMLInputElement>) => setDay(e.target.value)} />
        </Field>
        <Field label={t('Минут')} className="flex-1">
          <Input
            inputMode="numeric"
            value={minutes}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setMinutesTouched(true);
              setMinutes(e.target.value.replace(/[^\d]/g, ''));
            }}
            onClear={() => {
              setMinutesTouched(true);
              setMinutes('');
            }}
            placeholder="30"
          />
        </Field>
      </div>

      {kind.hasDistance && (
        <Field label={t('Дистанция, км')}>
          <Input
            inputMode="decimal"
            value={distance}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setDistance(e.target.value.replace(/[^\d.,]/g, ''))}
            onClear={() => setDistance('')}
            placeholder="5,0"
          />
        </Field>
      )}

      <div>
        <p className="mb-1.5 text-sm font-medium text-muted">{t('Как прошло')}</p>
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
      {workout && (
        <button
          type="button"
          onClick={() => void del()}
          className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-border py-3 text-center font-medium text-danger active:opacity-70"
        >
          <Trash2 size={ICON.action} /> {t('Удалить')}
        </button>
      )}
    </div>
  );
}
