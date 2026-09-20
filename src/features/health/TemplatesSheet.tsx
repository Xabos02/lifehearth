import { useState, type ChangeEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { Sheet } from '../../components/ui/Sheet';
import { Chip } from '../../components/ui/Chip';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { GTrash as Trash2, GPlus } from '../../components/ui/glyphs';
import { t } from '../../lib/i18n';
import type { WorkoutTemplate, WorkoutTemplateItem, WorkoutType } from '../../db/types';
import { WORKOUT_KINDS, workoutKind } from './workouts';
import { addTemplate, removeTemplate } from './templateRepo';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Шаблон выбран для загрузки в форму тренировки. */
  onPick: (tpl: WorkoutTemplate) => void;
}

/** Список шаблонов: выбрать (загрузить в форму), удалить или завести новый.
 *  Убрать лишние виды из выбранного — уже в самой форме тренировки: там
 *  видно, что сегодня реально делали, а что нет. */
export function TemplatesSheet({ open, onClose, onPick }: Props) {
  const [creating, setCreating] = useState(false);
  const templates = useLiveQuery(() => db.workoutTemplates.toArray(), []) ?? [];
  const list = alive(templates).sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  const close = () => {
    setCreating(false);
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title={creating ? t('Новый шаблон') : t('Шаблоны тренировок')}>
      {open && !creating && (
        <div className="space-y-2 pb-2">
          {list.length === 0 && <p className="py-4 text-center text-sm text-muted">{t('Шаблонов пока нет.')}</p>}
          {list.map((tpl) => (
            <div key={tpl.id} className="flex items-center gap-2 rounded-2xl border border-border p-3">
              <button type="button" onClick={() => onPick(tpl)} className="flex-1 text-left active:opacity-70">
                <p className="font-medium">{tpl.name}</p>
                <p className="text-sm text-muted">{summarize(tpl.items)}</p>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(t('Удалить шаблон?'))) void removeTemplate(tpl.id);
                }}
                className="p-1.5 text-muted active:opacity-60"
                aria-label={t('Удалить шаблон')}
              >
                <Trash2 size={18} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border py-3 font-medium text-accent active:opacity-70"
          >
            <GPlus size={16} /> {t('Новый шаблон')}
          </button>
        </div>
      )}
      {open && creating && <TemplateBuilder onDone={() => setCreating(false)} />}
    </Sheet>
  );
}

function summarize(items: WorkoutTemplateItem[]): string {
  const minutes = items.reduce((s, i) => s + i.minutes, 0);
  const names = items.map((i) => (i.type === 'custom' ? (i.customLabel ?? '') : t(workoutKind(i.type).label)));
  return `${names.join(', ')} · ${minutes} ${t('мин')}`;
}

interface Row {
  key: string;
  type: WorkoutType;
  minutes: string;
}

let rowSeq = 0;
function newRow(): Row {
  rowSeq++;
  return { key: `r${rowSeq}`, type: 'run', minutes: String(workoutKind('run').defaultMinutes) };
}

function TemplateBuilder({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [rows, setRows] = useState<Row[]>([newRow()]);

  const canSave = name.trim().length > 0 && rows.some((r) => Math.round(Number(r.minutes) || 0) > 0);

  async function save() {
    if (!canSave) return;
    const items: WorkoutTemplateItem[] = rows
      .filter((r) => Math.round(Number(r.minutes) || 0) > 0)
      .map((r) => ({ type: r.type, customLabel: null, customColor: null, minutes: Math.round(Number(r.minutes) || 0), distanceKm: null }));
    await addTemplate(name.trim(), items);
    onDone();
  }

  return (
    <div className="space-y-4 pb-2">
      <Field label={t('Название шаблона')}>
        <Input value={name} onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)} placeholder={t('Например, «День ног»')} />
      </Field>
      {rows.map((row, idx) => (
        <div key={row.key} className="space-y-2 rounded-2xl border border-border p-3">
          <div className="flex flex-wrap gap-2">
            {WORKOUT_KINDS.map((k) => (
              <Chip
                key={k.value}
                active={row.type === k.value}
                onClick={() => setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, type: k.value } : r)))}
              >
                {t(k.label)}
              </Chip>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Field label={t('Минут')} className="flex-1">
              <Input
                inputMode="numeric"
                value={row.minutes}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, minutes: e.target.value.replace(/[^\d]/g, '') } : r)))
                }
                placeholder="30"
              />
            </Field>
            {rows.length > 1 && (
              <button
                type="button"
                onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                className="mt-5 p-1.5 text-muted active:opacity-60"
                aria-label={t('Убрать')}
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>
          {idx === rows.length - 1 && (
            <button
              type="button"
              onClick={() => setRows((prev) => [...prev, newRow()])}
              className="flex items-center gap-1 text-sm font-medium text-accent active:opacity-70"
            >
              <GPlus size={14} /> {t('Добавить ещё вид')}
            </button>
          )}
        </div>
      ))}
      <Button className="w-full" disabled={!canSave} onClick={() => void save()}>
        {t('Сохранить шаблон')}
      </Button>
    </div>
  );
}
