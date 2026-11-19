import { useEffect, useRef, useState, type ChangeEvent } from 'react';
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
import { addWorkout, addWorkoutSession, removeWorkouts, sessionMates, updateWithMates, type WorkoutDraft } from './workoutRepo';
import { addTemplate } from './templateRepo';
import { TemplatesSheet } from './TemplatesSheet';
import { ItemFields } from './ItemFields';
import { itemFromSaved, kindPending, newItem, newItemLike, savedFromItem, type Item } from './workoutItem';
import { describeWorkout } from './workoutText';
import { chooseAction, confirmAction } from '../../components/ui/confirmStore';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Запись для правки; null — новая. */
  workout: Workout | null;
  /** День по умолчанию для новой (выбранный в календаре). */
  date: string;
  /** Новая тренировка сразу по шаблону — чип в карточке дня. */
  template?: WorkoutTemplate | null;
  /** Прошлая тренировка: новая начинается с её вида, а не всегда с бега. */
  last?: Workout | null;
}

/** Форма тренировки. Обязательное — дата и вид (минуты подставляются по
 *  виду, но их можно стереть), остальное по желанию: владелец просил отмечать занятие в два
 *  касания, а не заполнять анкету.
 *
 *  Новая запись — это набор ИЗ ОДНОГО ИЛИ НЕСКОЛЬКИХ видов «в одно целое»:
 *  можно добавить ещё вид кнопкой, загрузить шаблон и убрать из него то, чего
 *  сегодня не делали. Правка уже сохранённой записи — как раньше, один вид. */
export function WorkoutSheet({ open, onClose, workout, date, template = null, last = null }: Props) {
  const formKey = (workout?.id ?? 'new') + date + (template?.id ?? '');
  // Шаблон, загруженный «Из шаблона» уже в открытой форме: его имя встаёт в
  // заголовок так же, как у чипа. Помним его вместе с ключом формы: форма,
  // собранная заново (полночь на «Сегодня», другой чип при открытой шторке),
  // его уже не содержит — и заголовок о нём забывает. Закрытая шторка — тоже.
  const [picked, setPicked] = useState<{ key: string; tpl: WorkoutTemplate } | null>(null);
  if (!open && picked) setPicked(null);
  // Название шаблона не пропадает на входе (Влад, 17.11; канва
  // design/template-title, А): заголовок — имя, а то, что это новая запись,
  // — строкой под ним.
  const from = workout ? null : picked?.key === formKey ? picked.tpl : template;
  // Набранное не пропадает молча (аудит 1.64.0, H20; PROTOCOL §5.5): крестик,
  // свайп и тап мимо спрашивают, как у задачи и шаблона. Сохранение и
  // удаление закрывают мимо вопроса.
  const dirty = useRef(false);
  const done = () => {
    dirty.current = false;
    onClose();
  };
  const close = async () => {
    if (dirty.current && !(await confirmAction({ title: t('Закрыть без сохранения?'), confirmLabel: t('Закрыть без сохранения') }))) return;
    done();
  };
  return (
    <Sheet
      open={open}
      onClose={() => void close()}
      title={workout ? t('Тренировка') : from?.name || t('Новая тренировка')}
      subtitle={from ? t('Новая тренировка по шаблону') : undefined}
    >
      {open && (
        <WorkoutForm
          key={formKey}
          workout={workout}
          date={date}
          template={template}
          last={last}
          onTemplate={(tpl) => setPicked({ key: formKey, tpl })}
          onDirty={(d) => {
            dirty.current = d;
          }}
          onClose={done}
        />
      )}
    </Sheet>
  );
}

/** Виды шаблона → строки формы, свёрнутые до заголовков: их читают как
 *  программу. Пустой шаблон — обычная новая форма. */
function itemsFromTemplate(tpl: WorkoutTemplate): Item[] {
  return tpl.items.length ? tpl.items.map((i) => itemFromSaved(i, true)) : [newItem()];
}

function WorkoutForm({
  workout,
  date,
  template,
  last,
  onTemplate,
  onDirty,
  onClose,
}: {
  workout: Workout | null;
  date: string;
  template: WorkoutTemplate | null;
  last: Workout | null;
  onTemplate: (tpl: WorkoutTemplate) => void;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
}) {
  const [day, setDay] = useState(workout?.date ?? date);
  const [items, setItems] = useState<Item[]>(() =>
    workout ? [itemFromSaved(workout)] : template ? itemsFromTemplate(template) : [newItemLike(last)],
  );
  const [effort, setEffort] = useState<Workout['effort']>(workout?.effort ?? null);
  const [note, setNote] = useState(workout?.note ?? '');
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const savingRef = useRef(false);

  // «Изменено» — по тому, что уйдёт в запись (savedFromItem), а не по
  // касаниям: key у строки каждый раз новый, а раскрыл-свернул — та же
  // тренировка. Загруженный шаблон становится новой точкой отсчёта видов.
  const itemsSnap = JSON.stringify(items.map(savedFromItem));
  const [base, setBase] = useState(() => ({ day, effort, note, items: itemsSnap }));
  const itemsTouched = itemsSnap !== base.items || kindPending(items);
  const dirty = itemsTouched || day !== base.day || effort !== base.effort || note !== base.note;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // Минуты по желанию (задача 38): вид без времени — тоже тренировка.
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= todayKey();
  const pending = kindPending(items);
  const canSave = validDay && items.length > 0 && !pending;

  function updateItem(key: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  async function applyTemplate(tpl: WorkoutTemplate) {
    // Шаблон заменяет виды целиком: набранное поверх — только с вопросом
    // (аудит 1.64.0, H13). Заметка и «как прошло» остаются.
    if (itemsTouched && !(await confirmAction({ title: t('Заменить набранное шаблоном?'), confirmLabel: t('Заменить') }))) {
      setTemplatesOpen(false);
      return;
    }
    const next = itemsFromTemplate(tpl);
    setItems(next);
    setBase((b) => ({ ...b, items: JSON.stringify(next.map(savedFromItem)) }));
    onTemplate(tpl);
    setTemplatesOpen(false);
  }

  async function saveAsTemplate() {
    const name = window.prompt(t('Название шаблона:'))?.trim();
    if (!name) return;
    await addTemplate({ name, items: items.map(savedFromItem) });
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
        // превращали силовую + растяжку в две тренировки за месяц.
        groupId: workout?.groupId ?? null,
      }));
      if (workout) {
        // Перенос вида занятия на другой день — вопрос про всё занятие
        // (аудит 1.64.0, H2). «Только этот вид» — как раньше: он уходит
        // отдельной тренировкой; не обнулить groupId значило бы одно
        // занятие на двух днях. Тап мимо вопроса — передумал: форма остаётся.
        const mates = day !== workout.date ? await sessionMates(workout) : [];
        const whole =
          mates.length > 0 &&
          (await chooseAction({
            title: t('Перенести всё занятие?'),
            message: t('В занятии ещё: {kinds}.', { kinds: mates.map(describeWorkout).join(', ') }),
            confirmLabel: t('Перенести всё'),
            cancelLabel: t('Только этот вид'),
            danger: false,
          }));
        if (whole === null) return;
        const moved = day !== workout.date && !whole;
        await updateWithMates(workout.id, moved ? { ...drafts[0], groupId: null } : drafts[0], whole ? mates : []);
      } else if (drafts.length === 1) await addWorkout(drafts[0]);
      else await addWorkoutSession(drafts);
      onClose();
    } finally {
      savingRef.current = false;
    }
  };

  const del = async () => {
    if (!workout) return;
    if (!(await confirmAction(t('Удалить тренировку?')))) return;
    // Вид занятия — следом вопрос, всё ли занятие (аудит 1.64.0, H2).
    // «Только этот вид» — один; тап мимо — передумал, ничего не удаляется.
    const mates = await sessionMates(workout);
    const whole =
      mates.length > 0 &&
      (await chooseAction({
        title: t('Удалить всё занятие?'),
        message: t('В занятии ещё: {kinds}.', { kinds: mates.map(describeWorkout).join(', ') }),
        confirmLabel: t('Удалить всё занятие'),
        cancelLabel: t('Только этот вид'),
      }));
    if (whole === null) return;
    await removeWorkouts(whole ? [workout.id, ...mates.map((m) => m.id)] : [workout.id]);
    onClose();
  };

  return (
    <div className="space-y-4 pb-2">
      <Field label={t('Когда')}>
        <Input type="date" value={day} max={todayKey()} onChange={(e: ChangeEvent<HTMLInputElement>) => setDay(e.target.value)} />
      </Field>

      {items.map((it) => (
        <ItemFields
          key={it.key}
          item={it}
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
          disabled={pending}
          className={`w-full text-center text-sm font-medium text-lh-accent active:opacity-70 disabled:opacity-40 ${HIT_SLOP_44}`}
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
