import { useEffect, useRef, useState, type ChangeEvent } from 'react';
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
import { itemFromSaved, newItem, savedFromItem, type Item } from './workoutItem';
import { formatMinutes } from './workoutStats';
import { templateSummary } from './workoutText';
import { unlockTick } from './tick';

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

  const back = () => {
    dirty.current = false;
    setEditing(null);
  };
  const close = () => {
    // Шаблон на тридцать упражнений набирают долго: случайный свайп вниз не
    // должен стирать набранное молча (PROTOCOL §5.5).
    if (editing && dirty.current && !window.confirm(t('Закрыть без сохранения?'))) return;
    back();
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title={editing === 'new' ? t('Новый шаблон') : editing ? t('Шаблон') : t('Шаблоны тренировок')}>
      {open && !editing && (
        <div className="space-y-2 pb-2">
          {list.length === 0 ? (
            <p className="py-4 text-center text-sm text-lh-text-secondary">{t('Шаблонов пока нет.')}</p>
          ) : (
            <p className="pb-1 text-sm leading-snug text-lh-text-secondary">{t('Выберите шаблон — тренировка заполнится сама. Карандаш — изменить.')}</p>
          )}
          {list.map((tpl) => (
            <div key={tpl.id} className="flex items-center gap-1 rounded-2xl border border-lh-border-strong py-1 pl-3 pr-1">
              <button type="button" onClick={() => onPick(tpl)} className="min-h-11 min-w-0 flex-1 py-2 text-left active:opacity-70">
                <span className="block font-medium leading-snug [overflow-wrap:anywhere]">{tpl.name}</span>
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
  const canSave = draft.name.length > 0 && items.length > 0;

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
    if (!window.confirm(t('Удалить шаблон «{name}»? Записанные тренировки останутся.', { name: template.name }))) return;
    await removeTemplate(template.id);
    onDone();
  }

  return (
    <div className="space-y-4 pb-2">
      <div>
        <div className="flex items-end gap-2">
          <Field label={t('Название шаблона')} className="min-w-0 flex-1">
            <Input value={name} onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)} placeholder={t('Например, «День ног»')} maxLength={60} />
          </Field>
          <Field label={t('Время')} className="w-28 shrink-0">
            <button
              type="button"
              onClick={() => {
                // Тап — тот самый жест, которым iOS разрешает звук щелчка.
                unlockTick();
                setWheelOpen((v) => !v);
              }}
              aria-expanded={wheelOpen}
              aria-label={total > 0 ? t('Общее время: {time}', { time: formatMinutes(total, t) }) : t('Общее время: не задано')}
              className={`flex w-full items-center justify-center rounded-lh-btn border bg-lh-surface-2 px-2 py-3 tabular-nums transition-[border-color,box-shadow] active:opacity-80 ${
                wheelOpen ? 'border-lh-accent-border ring-2 ring-lh-accent-dim' : 'border-lh-border'
              } ${total > 0 ? 'text-lh-text-primary' : 'text-lh-text-secondary'}`}
            >
              {total > 0 ? formatMinutes(total, t) : '—'}
            </button>
          </Field>
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
