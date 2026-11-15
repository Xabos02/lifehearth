import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { AutoGrowTextarea, Field, Input } from '../../components/ui/Input';
import { GPencil, GPlus } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { t } from '../../lib/i18n';
import type { WorkoutTemplate } from '../../db/types';
import { addTemplate, removeTemplate, updateTemplate, useTemplates, type TemplateDraft } from './templateRepo';
import { ItemFields } from './ItemFields';
import { DurationWheel } from './DurationWheel';
import { itemFromSaved, kindPending, newItem, savedFromItem, type Item } from './workoutItem';
import { formatDuration } from '../../lib/duration';
import { templateSummary } from './workoutText';
import { unlockTick } from './tick';
import { confirmAction } from '../../components/ui/confirmStore';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Шаблон выбран для загрузки в форму тренировки. */
  onPick: (tpl: WorkoutTemplate) => void;
}

/** Список шаблонов: тап — выбрать (загрузить в форму тренировки), карандаш —
 *  открыть на правку, внизу — завести новый. Удаление — внутри шаблона, а не
 *  в списке: рядом с выбором его задевали бы случайно. Убрать лишние виды из
 *  выбранного — уже в самой форме тренировки: там видно, что сегодня реально
 *  делали, а что нет. Канва design/sport-templates. */
export function TemplatesSheet({ open, onClose, onPick }: Props) {
  // null — список; 'new' — новый шаблон; иначе — шаблон на правке.
  const [editing, setEditing] = useState<WorkoutTemplate | 'new' | null>(null);
  const dirty = useRef(false);
  const list = useTemplates();
  // Список ↔ редактор — другой экран в той же шторке: начинается сверху.
  // Иначе карандаш у нижнего шаблона открывал редактор с середины, а
  // название, время и памятка оставались за верхним краем.
  const top = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    top.current?.closest('.overflow-y-auto')?.scrollTo(0, 0);
  }, [editing]);

  const back = () => {
    dirty.current = false;
    setEditing(null);
  };
  const close = async () => {
    // Шаблон на тридцать упражнений набирают долго: случайный свайп вниз не
    // должен стирать набранное молча (PROTOCOL §5.5). Вопрос — тот же, что у
    // задачи (TaskEditSheet).
    if (
      editing &&
      dirty.current &&
      !(await confirmAction({ title: t('Закрыть без сохранения?'), confirmLabel: t('Закрыть без сохранения') }))
    )
      return;
    back();
    onClose();
  };

  return (
    <Sheet open={open} onClose={() => void close()} title={editing === 'new' ? t('Новый шаблон') : editing ? t('Шаблон') : t('Шаблоны тренировок')}>
      <div ref={top} />
      {open && !editing && list && (
        <div className="space-y-2 pb-2">
          {list.length === 0 ? (
            <p className="py-4 text-center text-sm text-lh-text-secondary">{t('Шаблонов пока нет.')}</p>
          ) : (
            <p className="pb-1 text-sm leading-snug text-lh-text-secondary">{t('Выберите шаблон — тренировка заполнится сама. Карандаш — изменить.')}</p>
          )}
          {list.map((tpl) => (
            <div key={tpl.id} className="flex items-center gap-1 rounded-2xl border border-lh-border-strong py-1 pl-3 pr-1">
              <button type="button" onClick={() => onPick(tpl)} className="min-h-11 min-w-0 flex-1 py-2 text-left active:opacity-70">
                <span className="block font-medium leading-snug wrap-anywhere">{tpl.name}</span>
                <span className="block text-sm text-lh-text-secondary">{templateSummary(tpl)}</span>
              </button>
              <button
                type="button"
                onClick={() => setEditing(tpl)}
                className="flex size-11 shrink-0 items-center justify-center text-lh-text-secondary active:opacity-60"
                aria-label={t('Изменить шаблон «{name}»', { name: tpl.name })}
              >
                <GPencil size={ICON.base} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-lh-border-strong py-3 font-medium text-lh-accent active:opacity-70"
          >
            <GPlus size={ICON.action} /> {t('Новый шаблон')}
          </button>
        </div>
      )}
      {open && editing && (
        <TemplateEditor
          key={editing === 'new' ? 'new' : editing.id}
          template={editing === 'new' ? null : editing}
          onDone={back}
          onDirty={(d) => {
            dirty.current = d;
          }}
        />
      )}
    </Sheet>
  );
}

/** Шаблон — новый или на правке — теми же полями вида, что в форме тренировки
 *  (ItemFields): свои виды, упражнения с подходами, весом и отдыхом внутри
 *  вида, минуты и км по желанию. Обязательно только название. */
function TemplateEditor({
  template,
  onDone,
  onDirty,
}: {
  template: WorkoutTemplate | null;
  onDone: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [note, setNote] = useState(template?.note ?? '');
  const [total, setTotal] = useState(template?.totalMinutes ?? 0);
  const [wheelOpen, setWheelOpen] = useState(false);
  // Новый шаблон стартует с пустых минут: время тут по желанию, а подставленные
  // «45 мин» силовой пришлось бы стирать в каждом шаблоне из упражнений.
  // Сохранённый открывается свёрнутым — его читают как программу.
  const [items, setItems] = useState<Item[]>(() =>
    template ? template.items.map((i) => itemFromSaved(i, true)) : [newItem('strength', '')],
  );
  const savingRef = useRef(false);

  // Пустые время и памятка — `undefined`: при правке поле уходит из записи.
  const draft: TemplateDraft = {
    name: name.trim(),
    items: items.map(savedFromItem),
    totalMinutes: total > 0 ? total : undefined,
    note: note.trim() || undefined,
  };
  const canSave = draft.name.length > 0 && items.length > 0 && !kindPending(items);

  // «Изменено» — по тому, что уйдёт в запись, а не по касаниям: раскрыл и
  // свернул строку — шаблон тот же, вопроса при закрытии нет.
  const snapshot = JSON.stringify(draft);
  const initial = useRef(snapshot);
  useEffect(() => {
    onDirty(snapshot !== initial.current);
  }, [snapshot, onDirty]);

  async function save() {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    try {
      if (template) await updateTemplate(template.id, draft);
      else await addTemplate(draft);
      onDone();
    } finally {
      savingRef.current = false;
    }
  }

  async function del() {
    if (!template) return;
    if (!(await confirmAction({ title: t('Удалить шаблон «{name}»?', { name: template.name }), message: t('Записанные тренировки останутся.') }))) return;
    await removeTemplate(template.id);
    onDone();
  }

  return (
    <div className="space-y-4 pb-2">
      <div>
        {/* Колонки одной высоты: кнопка времени тянется под поле названия,
            иначе она на пиксель выше, и подписи встают не в линию. */}
        <div className="flex gap-2">
          <Field label={t('Название шаблона')} className="min-w-0 flex-1">
            <Input value={name} onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)} placeholder={t('Например, «День ног»')} maxLength={60} />
          </Field>
          <label className="flex w-28 shrink-0 flex-col">
            <span className="mb-1.5 block text-sm font-medium text-lh-text-secondary">{t('Время')}</span>
            <button
              type="button"
              onClick={() => {
                // Тап — тот самый жест, которым iOS разрешает звук щелчка.
                unlockTick();
                setWheelOpen((v) => !v);
              }}
              aria-expanded={wheelOpen}
              aria-label={total > 0 ? t('Общее время: {time}', { time: formatDuration(total) }) : t('Общее время: не задано')}
              className={`flex min-h-11 w-full flex-1 items-center justify-center rounded-lh-btn border bg-lh-surface-2 px-2 tabular-nums transition-[border-color,box-shadow] active:opacity-80 ${
                wheelOpen ? 'border-lh-accent-border ring-2 ring-lh-accent-dim' : 'border-lh-border'
              } ${total > 0 ? 'text-lh-text-primary' : 'text-lh-text-secondary'}`}
            >
              {total > 0 ? formatDuration(total) : '—'}
            </button>
          </label>
        </div>
        {wheelOpen && (
          <div className="mt-2.5">
            <DurationWheel value={total} onChange={setTotal} />
          </div>
        )}
        {/* Общее время — время плана. Сводки считают минуты видов из записи:
            без них тренировка по шаблону даёт «0 ч за месяц» — говорим сразу. */}
        {total > 0 && draft.items.every((i) => i.minutes === 0) && (
          <p className="mt-1.5 text-xs leading-snug text-lh-text-secondary">
            {t('В часы за месяц идут минуты видов — укажите их по тапу на название вида.')}
          </p>
        )}
      </div>
      <Field label={t('Памятка')}>
        <AutoGrowTextarea
          value={note}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)}
          placeholder={t('Правила, прогрессия — по желанию')}
          maxLength={2000}
        />
      </Field>
      {items.map((it) => (
        <ItemFields
          key={it.key}
          item={it}
          removable={items.length > 1}
          onRemove={() => setItems((prev) => prev.filter((x) => x.key !== it.key))}
          onChange={(patch) => setItems((prev) => prev.map((x) => (x.key === it.key ? { ...x, ...patch } : x)))}
        />
      ))}
      <button
        type="button"
        onClick={() => setItems((prev) => [...prev, newItem('strength', '')])}
        className={`flex items-center gap-1 rounded-full border border-dashed border-lh-border-strong px-3.5 py-1.5 text-sm font-medium text-lh-accent active:opacity-70 ${HIT_SLOP_44}`}
      >
        <GPlus size={ICON.inline} /> {t('Добавить ещё вид')}
      </button>
      <div>
        <div className="flex gap-3">
          {template && (
            <Button variant="danger" className="shrink-0" onClick={() => void del()}>
              {t('Удалить')}
            </Button>
          )}
          {/* При правке — короткое «Сохранить»: рядом с «Удалить» длинная
              подпись на экране 320 рвалась на две строки. */}
          <Button className="min-w-0 flex-1" disabled={!canSave} onClick={() => void save()}>
            {template ? t('Сохранить') : t('Сохранить шаблон')}
          </Button>
        </div>
        <p className="mt-1.5 text-center text-xs text-lh-text-secondary">{t('Сохраняется и без минут и км')}</p>
      </div>
    </div>
  );
}
