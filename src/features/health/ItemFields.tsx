import { useState, type ChangeEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { Chip } from '../../components/ui/Chip';
import { Button } from '../../components/ui/Button';
import { AutoGrowTextarea, Field, Input } from '../../components/ui/Input';
import { GChevronDown, GClose, GPlus } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { getLang, t } from '../../lib/i18n';
import type { WorkoutExercise, WorkoutType } from '../../db/types';
import { WORKOUT_KINDS } from './workouts';
import { addExerciseDef } from './exerciseDefRepo';
import { cleanExercises, exerciseSuggestions, formatAmount, UNIT_OPTIONS } from './exercises';
import { exerciseRow, kindOfItem, type ExerciseRow, type Item } from './workoutItem';
import { formatMinutes } from './workoutStats';

// Один вид внутри формы тренировки и шаблона: вид, минуты, км, упражнения.
// Общий для обеих шторок: до задачи 38 у шаблона был свой урезанный
// конструктор — без своих упражнений, с обязательными минутами, а строку без
// минут он молча выкидывал при сохранении.
//
// С 15.11.2026 (канва design/sport-templates, вариант Б) всё, что уже
// заполнено, читается как программа: вид — заголовком, упражнение — строкой
// «название · 4 × 6–8 · вес · отдых · пометка». Тап раскрывает для правки.
// Шаблон в зале читают чаще, чем правят, а стена полей с обрезанными
// названиями («Подтягива…») читалась плохо.

const digits = (v: string, max: number) => v.replace(/[^\d]/g, '').slice(0, max);
/** Дробное число: цифры и один разделитель. Второй («5,2,1») поле принимало,
 *  а запись выходила без километров — молча. */
const decimal = (v: string) => {
  const s = v.replace(/[^\d.,]/g, '');
  const i = s.search(/[.,]/);
  return i < 0 ? s : s.slice(0, i + 1) + s.slice(i + 1).replace(/[.,]/g, '');
};

const NUM =
  'h-11 w-14 shrink-0 rounded-lh-btn border border-lh-border bg-lh-surface-2 text-center tabular-nums text-lh-text-primary outline-none transition-[border-color,box-shadow] placeholder:text-lh-text-secondary focus:border-lh-accent-border focus:ring-2 focus:ring-lh-accent-dim';

export function ItemFields({
  item,
  removable,
  onRemove,
  onChange,
}: {
  item: Item;
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
      // Две тренировки за день: индекс по дате их не упорядочивает — свежая
      // по времени записи первой, иначе подсказка брала подходы с ранней.
      ws.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
      return [...alive(ws), ...alive(tpls).flatMap((tpl) => tpl.items)];
    }, []) ?? [];
  const [addingCustom, setAddingCustom] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const kind = kindOfItem(item);
  // Своё название — данные человека: не переводим.
  const kindName = item.type === 'custom' ? kind.label : t(kind.label);
  const hasDistance = kind.hasDistance || item.keepsDistance;
  const summary = [
    Number(item.minutes) > 0 ? formatMinutes(Number(item.minutes), t) : null,
    hasDistance && item.distance ? `${item.distance} ${t('км')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const suggestions = exerciseSuggestions(sources, item, item.exercises.map((e) => e.name));

  function pickType(type: WorkoutType, customLabel: string | null = null, customColor: string | null = null) {
    // Сменили вид — километры чужого вида больше не держим.
    const patch: Partial<Item> = { type, customLabel, customColor, keepsDistance: false };
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

  const setRows = (exercises: ExerciseRow[]) => onChange({ exercises });
  const setExercise = (key: string, patch: Partial<ExerciseRow>) =>
    setRows(item.exercises.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  /** Раскрыта одна строка: остальные дописанные сворачиваются обратно в
   *  текст. Строка без названия остаётся открытой — она ещё не упражнение. */
  const foldOthers = (rows: ExerciseRow[], key: string) =>
    rows.map((e) => (e.key === key ? { ...e, open: true } : e.open && e.name.trim() ? { ...e, open: false } : e));
  const openExercise = (key: string) => setRows(foldOthers(item.exercises, key));
  function addExercise(e?: WorkoutExercise) {
    const row = exerciseRow(e);
    setRows(row.open ? foldOthers([...item.exercises, row], row.key) : [...item.exercises, row]);
  }
  function moveExercise(key: string, by: -1 | 1) {
    const i = item.exercises.findIndex((e) => e.key === key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= item.exercises.length) return;
    const rows = [...item.exercises];
    [rows[i], rows[j]] = [rows[j], rows[i]];
    setRows(rows);
  }

  return (
    <div className="rounded-2xl border border-lh-border-strong px-3 pb-3 pt-0.5" data-testid="workout-kind">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChange({ collapsed: !item.collapsed })}
          aria-expanded={!item.collapsed}
          // Имя с приставкой: голое «Силовая» совпадало бы с чипом вида ниже.
          aria-label={[t('Вид: {name}', { name: kindName }), summary].filter(Boolean).join(', ')}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left active:opacity-70"
        >
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: kind.color }} aria-hidden />
          <span className="truncate font-semibold">{kindName}</span>
          <GChevronDown
            size={ICON.inline}
            className={`shrink-0 text-lh-text-secondary transition-transform ${item.collapsed ? '' : 'rotate-180'}`}
          />
          {item.collapsed && summary && (
            <span className="ml-auto shrink-0 whitespace-nowrap text-sm tabular-nums text-lh-text-secondary">{summary}</span>
          )}
        </button>
        {/* «Убрать» — омоним: в словаре «Clear» (снять срок задачи), здесь
            убирается весь вид — английская ветка явная. */}
        {removable && (
          <button type="button" onClick={onRemove} className={`p-1.5 text-lh-text-secondary active:opacity-60 ${HIT_SLOP_44}`} aria-label={getLang() === 'en' ? 'Remove' : 'Убрать'}>
            <GClose size={ICON.action} />
          </button>
        )}
      </div>

      {!item.collapsed && (
        <div className="space-y-3 pb-3 pt-1">
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
            {hasDistance && (
              <Field label={t('Дистанция, км')} className="flex-1">
                <Input
                  inputMode="decimal"
                  value={item.distance}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ distance: decimal(e.target.value) })}
                  onClear={() => onChange({ distance: '' })}
                  placeholder={t('по желанию')}
                />
              </Field>
            )}
          </div>
        </div>
      )}

      {item.exercises.map((ex, i) =>
        ex.open ? (
          <ExerciseEditor
            key={ex.key}
            ex={ex}
            first={i === 0}
            last={i === item.exercises.length - 1}
            onChange={(patch) => setExercise(ex.key, patch)}
            onMove={(by) => moveExercise(ex.key, by)}
            onRemove={() => setRows(item.exercises.filter((e) => e.key !== ex.key))}
          />
        ) : (
          <ExerciseLine key={ex.key} ex={ex} onOpen={() => openExercise(ex.key)} />
        ),
      )}

      <div className={`flex flex-wrap gap-2 ${item.exercises.length > 0 ? 'border-t border-lh-border pt-3' : ''}`}>
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

/** Упражнение строкой, как в программе: название целиком, справа «4 × 6–8»,
 *  ниже вес и отдых, ещё ниже пометка. Тап раскрывает для правки. */
function ExerciseLine({ ex, onOpen }: { ex: ExerciseRow; onOpen: () => void }) {
  // Число строкой собирает та же чистка, что и при сохранении: «8–6» в полях
  // читается как «6–8» уже здесь, а не после записи.
  const amount = formatAmount(cleanExercises([{ ...ex, name: ex.name || '·' }])[0], ' × ');
  const weight = ex.weight.trim();
  const rest = ex.rest.trim();
  const note = ex.note.trim();
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="exercise-row"
      className="block min-h-11 w-full border-t border-lh-border py-2.5 text-left active:opacity-70"
    >
      <span className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 font-medium leading-snug [overflow-wrap:anywhere]">{ex.name.trim() || t('Без названия')}</span>
        {amount && <span className="shrink-0 whitespace-nowrap tabular-nums">{amount}</span>}
      </span>
      {(weight || rest) && (
        <span className="mt-0.5 block text-sm leading-snug [overflow-wrap:anywhere]">
          {weight}
          {rest && <span className="text-lh-text-secondary">{`${weight ? ' · ' : ''}${t('отдых {rest}', { rest })}`}</span>}
        </span>
      )}
      {note && <span className="mt-0.5 block whitespace-pre-line text-sm leading-snug text-lh-text-secondary [overflow-wrap:anywhere]">{note}</span>}
    </button>
  );
}

/** Раскрытое упражнение: числа — с цифровой клавиатуры, диапазон — двумя
 *  полями (на цифровой клавиатуре iPhone нет тире), единицы — чипами, вес и
 *  отдых — словами человека («+10–15 кг», «90 сек»). */
function ExerciseEditor({
  ex,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  ex: ExerciseRow;
  first: boolean;
  last: boolean;
  onChange: (patch: Partial<ExerciseRow>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const unit = UNIT_OPTIONS.find((u) => u.value === ex.unit) ?? UNIT_OPTIONS[0];
  const caption = 'mb-1 block text-xs text-lh-text-secondary';
  const sign = 'flex h-11 items-center text-lh-text-secondary';
  const arrow =
    'flex size-11 shrink-0 items-center justify-center rounded-lh-btn border border-lh-border-strong text-lh-text-secondary active:scale-95 disabled:opacity-40';
  return (
    <div className="my-2 space-y-3 rounded-lh-btn border border-lh-accent-border p-3" data-testid="exercise-editor">
      <Input
        value={ex.name}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ name: e.target.value })}
        placeholder={t('Упражнение')}
        aria-label={t('Название упражнения')}
        maxLength={80}
        // Новая пустая строка — сразу с курсором: её открыли, чтобы писать.
        autoFocus={!ex.name}
      />
      <div className="flex items-end gap-2">
        <div>
          <span className={caption} aria-hidden>
            {t('Подходы')}
          </span>
          <input
            inputMode="numeric"
            value={ex.sets}
            onChange={(e) => onChange({ sets: digits(e.target.value, 2) })}
            placeholder="—"
            aria-label={t('Подходов')}
            className={NUM}
          />
        </div>
        <span className={sign} aria-hidden>
          ×
        </span>
        <div>
          <span className={caption} aria-hidden>
            {t(unit.field)}
          </span>
          <input
            inputMode="numeric"
            value={ex.reps}
            onChange={(e) => onChange({ reps: digits(e.target.value, 4) })}
            placeholder="—"
            aria-label={t('Повторов')}
            className={NUM}
          />
        </div>
        <span className={sign} aria-hidden>
          –
        </span>
        <div>
          <span className={caption} aria-hidden>
            {t('до')}
          </span>
          <input
            inputMode="numeric"
            value={ex.repsTo}
            onChange={(e) => onChange({ repsTo: digits(e.target.value, 4) })}
            placeholder="—"
            aria-label={t('Верхняя граница')}
            className={NUM}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('В чём считать')}>
        {UNIT_OPTIONS.map((u) => (
          <Chip key={u.chip} active={ex.unit === u.value} onClick={() => onChange({ unit: u.value })}>
            {t(u.chip)}
          </Chip>
        ))}
      </div>
      <div className="flex gap-2">
        <Field label={t('Вес')} className="min-w-0 flex-1">
          <Input value={ex.weight} onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ weight: e.target.value })} placeholder={t('+10 кг')} maxLength={40} />
        </Field>
        <Field label={t('Отдых')} className="min-w-0 flex-1">
          <Input value={ex.rest} onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ rest: e.target.value })} placeholder={t('2 мин')} maxLength={24} />
        </Field>
      </div>
      <Field label={t('Заметка')}>
        <AutoGrowTextarea
          value={ex.note}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange({ note: e.target.value })}
          placeholder={t('Техника, разминочный подход…')}
          maxLength={600}
        />
      </Field>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onMove(-1)} disabled={first} aria-label={t('Поднять упражнение')} className={arrow}>
          <GChevronDown size={ICON.base} className="rotate-180" />
        </button>
        <button type="button" onClick={() => onMove(1)} disabled={last} aria-label={t('Опустить упражнение')} className={arrow}>
          <GChevronDown size={ICON.base} />
        </button>
        {/* «Убрать» — омоним, как у вида: английская ветка явная. */}
        <button type="button" onClick={onRemove} aria-label={t('Убрать упражнение')} className="min-h-11 px-2 text-sm font-medium text-lh-text-secondary active:opacity-60">
          {getLang() === 'en' ? 'Remove' : 'Убрать'}
        </button>
        {/* Без названия строка не упражнение: свернуть её нельзя, только убрать. */}
        <Button className="ml-auto" disabled={!ex.name.trim()} onClick={() => onChange({ open: false })}>
          {t('Готово')}
        </Button>
      </div>
    </div>
  );
}
