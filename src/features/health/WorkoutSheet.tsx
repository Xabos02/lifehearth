import { useRef, useState, type ChangeEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { Sheet } from '../../components/ui/Sheet';
import { Chip } from '../../components/ui/Chip';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { GTrash as Trash2, GPlus, GClose } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { getLang, t } from '../../lib/i18n';
import { todayKey } from '../../lib/dates';
import type { Workout, WorkoutTemplate, WorkoutType } from '../../db/types';
import { EFFORT_LABELS, WORKOUT_KINDS, workoutKind, type WorkoutKind } from './workouts';
import { addWorkout, addWorkoutSession, removeWorkout, updateWorkout, type WorkoutDraft } from './workoutRepo';
import { addExerciseDef } from './exerciseDefRepo';
import { addTemplate } from './templateRepo';
import { TemplatesSheet } from './TemplatesSheet';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Запись для правки; null — новая. */
  workout: Workout | null;
  /** День по умолчанию для новой (выбранный в календаре). */
  date: string;
}

interface Item {
  key: string;
  type: WorkoutType;
  customLabel: string | null;
  customColor: string | null;
  minutes: string;
  distance: string;
  minutesTouched: boolean;
}

let itemKeySeq = 0;
function newItem(type: WorkoutType = 'run', minutes = String(workoutKind('run').defaultMinutes)): Item {
  itemKeySeq++;
  return { key: `i${itemKeySeq}`, type, customLabel: null, customColor: null, minutes, distance: '', minutesTouched: false };
}

function kindOfItem(it: Pick<Item, 'type' | 'customLabel' | 'customColor'>): WorkoutKind {
  if (it.type === 'custom') {
    return { value: 'custom', label: it.customLabel ?? '', color: it.customColor ?? 'var(--app-muted)', hasDistance: false, defaultMinutes: 30 };
  }
  return workoutKind(it.type);
}

/** Форма тренировки. Обязательное — вид и минуты (минуты подставляются по
 *  виду), остальное по желанию: владелец просил отмечать занятие в два
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
  const [items, setItems] = useState<Item[]>(() =>
    workout
      ? [
          {
            key: 'edit',
            type: workout.type,
            customLabel: workout.customLabel,
            customColor: workout.customColor,
            minutes: String(workout.minutes),
            distance: workout.distanceKm != null ? String(workout.distanceKm).replace('.', ',') : '',
            minutesTouched: true,
          },
        ]
      : [newItem()],
  );
  const [effort, setEffort] = useState<Workout['effort']>(workout?.effort ?? null);
  const [note, setNote] = useState(workout?.note ?? '');
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const savingRef = useRef(false);

  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= todayKey();
  const minutesOf = (it: Item) => Math.round(Number(it.minutes.replace(',', '.')) || 0);
  const canSave = validDay && items.some((it) => minutesOf(it) > 0);

  function updateItem(key: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  function pickType(key: string, type: WorkoutType, customLabel: string | null = null, customColor: string | null = null) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.key !== key) return it;
        const patch: Partial<Item> = { type, customLabel, customColor };
        if (!it.minutesTouched) patch.minutes = String(kindOfItem({ type, customLabel, customColor }).defaultMinutes);
        return { ...it, ...patch };
      }),
    );
  }

  function applyTemplate(tpl: WorkoutTemplate) {
    setItems(
      tpl.items.length
        ? tpl.items.map((ti) => ({
            key: `t${itemKeySeq++}`,
            type: ti.type,
            customLabel: ti.customLabel,
            customColor: ti.customColor,
            minutes: String(ti.minutes),
            distance: ti.distanceKm != null ? String(ti.distanceKm).replace('.', ',') : '',
            minutesTouched: true,
          }))
        : [newItem()],
    );
    setTemplatesOpen(false);
  }

  async function saveAsTemplate() {
    const name = window.prompt(t('Название шаблона:'))?.trim();
    if (!name) return;
    await addTemplate(
      name,
      items.map((it) => {
        const k = kindOfItem(it);
        const dist = k.hasDistance ? Number(it.distance.replace(',', '.')) : 0;
        return {
          type: it.type,
          customLabel: it.customLabel,
          customColor: it.customColor,
          minutes: minutesOf(it),
          distanceKm: k.hasDistance && dist > 0 ? Math.round(dist * 100) / 100 : null,
        };
      }),
    );
  }

  const save = async () => {
    if (savingRef.current || !canSave) return;
    savingRef.current = true;
    try {
      const drafts: WorkoutDraft[] = items
        .filter((it) => minutesOf(it) > 0)
        .map((it) => {
          const k = kindOfItem(it);
          const dist = k.hasDistance ? Number(it.distance.replace(',', '.')) : 0;
          return {
            date: day,
            type: it.type,
            minutes: minutesOf(it),
            distanceKm: k.hasDistance && dist > 0 ? Math.round(dist * 100) / 100 : null,
            effort,
            note: note.trim(),
            source: workout?.source ?? ('manual' as const),
            // Правка вида оставляет его в занятии: с null исправленные минуты
            // превращали силовую + растяжку в две тренировки за месяц. Перенос
            // на другой день — уже отдельное занятие.
            groupId: workout && day === workout.date ? (workout.groupId ?? null) : null,
            customLabel: it.type === 'custom' ? it.customLabel : null,
            customColor: it.type === 'custom' ? it.customColor : null,
          };
        });
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
          onPickType={(type, label, color) => pickType(it.key, type, label, color)}
          onMinutes={(v) => updateItem(it.key, { minutes: v, minutesTouched: true })}
          onDistance={(v) => updateItem(it.key, { distance: v })}
        />
      ))}

      {!workout && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setItems((prev) => [...prev, newItem()])}
            className={`flex items-center gap-1 rounded-full border border-dashed border-border px-3.5 py-1.5 text-sm font-medium text-accent active:opacity-70 ${HIT_SLOP_44}`}
          >
            <GPlus size={ICON.inline} /> {t('Добавить ещё вид')}
          </button>
          <button
            type="button"
            onClick={() => setTemplatesOpen(true)}
            className={`flex items-center gap-1 rounded-full border border-border px-3.5 py-1.5 text-sm font-medium text-muted active:opacity-70 ${HIT_SLOP_44}`}
          >
            {t('Из шаблона')}
          </button>
        </div>
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
      {!workout && (
        <button
          type="button"
          onClick={() => void saveAsTemplate()}
          className={`w-full text-center text-sm font-medium text-accent active:opacity-70 ${HIT_SLOP_44}`}
        >
          {t('Сделать из этого набора шаблон')}
        </button>
      )}
      {workout && (
        <button
          type="button"
          onClick={() => void del()}
          className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-border py-3 text-center font-medium text-danger active:opacity-70"
        >
          <Trash2 size={ICON.action} /> {t('Удалить')}
        </button>
      )}

      <TemplatesSheet open={templatesOpen} onClose={() => setTemplatesOpen(false)} onPick={applyTemplate} />
    </div>
  );
}

function ItemFields({
  item,
  index,
  removable,
  onRemove,
  onPickType,
  onMinutes,
  onDistance,
}: {
  item: Item;
  index: number;
  removable: boolean;
  onRemove: () => void;
  onPickType: (type: WorkoutType, customLabel: string | null, customColor: string | null) => void;
  onMinutes: (v: string) => void;
  onDistance: (v: string) => void;
}) {
  const defs = useLiveQuery(() => db.exerciseDefs.toArray(), []) ?? [];
  const aliveDefs = defs.filter((d) => !d.deletedAt);
  const [addingCustom, setAddingCustom] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const kind = kindOfItem(item);

  async function confirmCustom() {
    const name = customInput.trim();
    if (!name) return;
    const def = await addExerciseDef(name);
    onPickType('custom', def.label, def.color);
    setAddingCustom(false);
    setCustomInput('');
  }

  return (
    <div className="space-y-3 rounded-2xl border border-border p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted">{index === 0 ? t('Вид') : `${t('Вид')} ${index + 1}`}</p>
        {/* «Убрать» — омоним: в словаре «Clear» (снять срок задачи), здесь
            убирается весь вид — английская ветка явная. */}
        {removable && (
          <button type="button" onClick={onRemove} className={`p-1.5 text-muted active:opacity-60 ${HIT_SLOP_44}`} aria-label={getLang() === 'en' ? 'Remove' : 'Убрать'}>
            <GClose size={ICON.action} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {WORKOUT_KINDS.map((k) => (
          <Chip key={k.value} active={item.type === k.value} onClick={() => onPickType(k.value, null, null)}>
            {t(k.label)}
          </Chip>
        ))}
        {aliveDefs.map((d) => (
          <Chip key={d.id} active={item.type === 'custom' && item.customLabel === d.label} onClick={() => onPickType('custom', d.label, d.color)}>
            {d.label}
          </Chip>
        ))}
        <Chip active={addingCustom} onClick={() => setAddingCustom((v) => !v)}>
          + {t('Своё')}
        </Chip>
      </div>
      {addingCustom && (
        <div className="flex gap-2">
          <Input
            value={customInput}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setCustomInput(e.target.value)}
            onClear={() => setCustomInput('')}
            placeholder={t('Название упражнения')}
          />
          <Button className="shrink-0" disabled={!customInput.trim()} onClick={() => void confirmCustom()}>
            {t('Добавить')}
          </Button>
        </div>
      )}

      <div className="flex gap-3">
        <Field label={t('Минут')} className="flex-1">
          <Input
            inputMode="numeric"
            value={item.minutes}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onMinutes(e.target.value.replace(/[^\d]/g, ''))}
            onClear={() => onMinutes('')}
            placeholder="30"
          />
        </Field>
        {kind.hasDistance && (
          <Field label={t('Дистанция, км')} className="flex-1">
            <Input
              inputMode="decimal"
              value={item.distance}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onDistance(e.target.value.replace(/[^\d.,]/g, ''))}
              onClear={() => onDistance('')}
              placeholder="5,0"
            />
          </Field>
        )}
      </div>
    </div>
  );
}
