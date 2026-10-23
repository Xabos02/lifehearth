import { useState, type ChangeEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { Chip } from '../../components/ui/Chip';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { GClose, GPlus } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { getLang, t } from '../../lib/i18n';
import type { WorkoutExercise, WorkoutType } from '../../db/types';
import { WORKOUT_KINDS } from './workouts';
import { addExerciseDef } from './exerciseDefRepo';
import { exerciseSuggestions } from './exercises';
import { exerciseRow, kindOfItem, type ExerciseRow, type Item } from './workoutItem';

// Один вид внутри формы тренировки и шаблона: вид, минуты, км, упражнения.
// Общий для обеих шторок: до задачи 38 у шаблона был свой урезанный
// конструктор — без своих упражнений, с обязательными минутами, а строку без
// минут он молча выкидывал при сохранении.

const digits = (v: string, max: number) => v.replace(/[^\d]/g, '').slice(0, max);

export function ItemFields({
  item,
  index,
  removable,
  onRemove,
  onChange,
}: {
  item: Item;
  index: number;
  removable: boolean;
  onRemove: () => void;
  onChange: (patch: Partial<Item>) => void;
}) {
  const defs = useLiveQuery(() => db.exerciseDefs.toArray(), []) ?? [];
  const aliveDefs = defs.filter((d) => !d.deletedAt);
  // Откуда подсказки упражнений: последние записи (свежие первыми) и шаблоны.
  // ponytail: 200 последних записей — дальше в прошлое за именами не ходим.
  const sources =
    useLiveQuery(async () => {
      const [ws, tpls] = await Promise.all([
        db.workouts.orderBy('date').reverse().limit(200).toArray(),
        db.workoutTemplates.toArray(),
      ]);
      return [...alive(ws), ...alive(tpls).flatMap((tpl) => tpl.items)];
    }, []) ?? [];
  const [addingCustom, setAddingCustom] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const kind = kindOfItem(item);
  const suggestions = exerciseSuggestions(sources, item, item.exercises.map((e) => e.name));

  function pickType(type: WorkoutType, customLabel: string | null = null, customColor: string | null = null) {
    const patch: Partial<Item> = { type, customLabel, customColor };
    if (!item.minutesTouched) patch.minutes = String(kindOfItem({ type, customLabel, customColor }).defaultMinutes);
    onChange(patch);
  }

  async function confirmCustom() {
    const name = customInput.trim();
    if (!name) return;
    const def = await addExerciseDef(name);
    pickType('custom', def.label, def.color);
    setAddingCustom(false);
    setCustomInput('');
  }

  const setExercise = (key: string, patch: Partial<ExerciseRow>) =>
    onChange({ exercises: item.exercises.map((e) => (e.key === key ? { ...e, ...patch } : e)) });
  const addExercise = (e: WorkoutExercise = { name: '', sets: null, reps: null }) =>
    onChange({ exercises: [...item.exercises, exerciseRow(e)] });

  return (
    <div className="space-y-3 rounded-2xl border border-lh-border-strong p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-lh-text-secondary">{index === 0 ? t('Вид') : `${t('Вид')} ${index + 1}`}</p>
        {/* «Убрать» — омоним: в словаре «Clear» (снять срок задачи), здесь
            убирается весь вид — английская ветка явная. */}
        {removable && (
          <button type="button" onClick={onRemove} className={`p-1.5 text-lh-text-secondary active:opacity-60 ${HIT_SLOP_44}`} aria-label={getLang() === 'en' ? 'Remove' : 'Убрать'}>
            <GClose size={ICON.action} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {WORKOUT_KINDS.map((k) => (
          <Chip key={k.value} active={item.type === k.value} onClick={() => pickType(k.value)}>
            {t(k.label)}
          </Chip>
        ))}
        {aliveDefs.map((d) => (
          <Chip key={d.id} active={item.type === 'custom' && item.customLabel === d.label} onClick={() => pickType('custom', d.label, d.color)}>
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
            // «Своё» — новый вид, а не упражнение внутри вида: подписи не путать.
            placeholder={t('Название вида')}
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
            onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ minutes: digits(e.target.value, 4), minutesTouched: true })}
            onClear={() => onChange({ minutes: '', minutesTouched: true })}
            placeholder={t('по желанию')}
          />
        </Field>
        {kind.hasDistance && (
          <Field label={t('Дистанция, км')} className="flex-1">
            <Input
              inputMode="decimal"
              value={item.distance}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ distance: e.target.value.replace(/[^\d.,]/g, '') })}
              onClear={() => onChange({ distance: '' })}
              placeholder={t('по желанию')}
            />
          </Field>
        )}
      </div>

      {item.exercises.length > 0 && (
        <div>
          <div className="mb-1 flex items-baseline justify-between text-sm font-medium text-lh-text-secondary">
            <span>{t('Упражнения')}</span>
            <span className="text-xs font-normal">{t('подходы × повторы')}</span>
          </div>
          {item.exercises.map((ex, i) => (
            <div key={ex.key} className={`flex items-center gap-2 ${i > 0 ? 'mt-2 border-t border-lh-border pt-2' : ''}`}>
              {/* Заполненное имя читается строкой, пустое — полем: так на
                  канве design/sport-exercises (А). Отступ один и тот же, чтобы
                  текст не прыгал на первой букве. */}
              <input
                value={ex.name}
                onChange={(e) => setExercise(ex.key, { name: e.target.value })}
                placeholder={t('Упражнение')}
                aria-label={t('Название упражнения')}
                className={`h-11 min-w-0 flex-1 rounded-lh-btn border bg-transparent px-3 font-medium text-ellipsis text-lh-text-primary outline-none transition-[border-color,box-shadow] placeholder:font-normal placeholder:text-lh-text-secondary focus:border-lh-accent-border focus:ring-2 focus:ring-lh-accent-dim ${
                  ex.name ? 'border-transparent' : 'border-lh-border-strong'
                }`}
              />
              <input
                inputMode="numeric"
                value={ex.sets}
                onChange={(e) => setExercise(ex.key, { sets: digits(e.target.value, 2) })}
                placeholder="—"
                aria-label={t('Подходов')}
                className="h-11 w-12 shrink-0 rounded-lh-btn border border-lh-border bg-lh-surface-2 text-center tabular-nums text-lh-text-primary outline-none transition-[border-color,box-shadow] placeholder:text-lh-text-secondary focus:border-lh-accent-border focus:ring-2 focus:ring-lh-accent-dim"
              />
              <span className="text-lh-text-secondary" aria-hidden>
                ×
              </span>
              <input
                inputMode="numeric"
                value={ex.reps}
                onChange={(e) => setExercise(ex.key, { reps: digits(e.target.value, 3) })}
                placeholder="—"
                aria-label={t('Повторов')}
                className="h-11 w-12 shrink-0 rounded-lh-btn border border-lh-border bg-lh-surface-2 text-center tabular-nums text-lh-text-primary outline-none transition-[border-color,box-shadow] placeholder:text-lh-text-secondary focus:border-lh-accent-border focus:ring-2 focus:ring-lh-accent-dim"
              />
              <button
                type="button"
                onClick={() => onChange({ exercises: item.exercises.filter((e) => e.key !== ex.key) })}
                className={`shrink-0 p-1.5 text-lh-text-secondary active:opacity-60 ${HIT_SLOP_44}`}
                aria-label={t('Убрать упражнение')}
              >
                <GClose size={ICON.base} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {suggestions.map((s) => (
          <button
            key={s.name}
            type="button"
            onClick={() => addExercise(s)}
            className={`rounded-full border border-lh-border bg-lh-surface-2 px-3 py-1.5 text-sm text-lh-text-primary active:opacity-70 ${HIT_SLOP_44}`}
          >
            + {s.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => addExercise()}
          className={`flex items-center gap-1 rounded-full border border-dashed border-lh-border-strong px-3.5 py-1.5 text-sm font-medium text-lh-accent active:opacity-70 ${HIT_SLOP_44}`}
        >
          <GPlus size={ICON.inline} /> {t('Упражнение')}
        </button>
      </div>
    </div>
  );
}
