import { useState } from 'react';
import { Sheet } from '../../components/ui/Sheet';
import { AutoGrowTextarea, Field, Input, Select } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import type { FamilyTask, FamilyMember, Priority } from '../../db/types';
import { createFamilyTask, updateFamilyTask, deleteFamilyTask } from '../../lib/family/familyRepo';
import { addDaysKey, todayKey } from '../../lib/dates';
import { PRESET_COLORS, isLightColor } from '../../lib/colors';
import { ALLDAY_REMIND_TIME, cancelReminder, scheduleReminder } from '../../lib/push';
import { GCheck as Check } from '../../components/ui/glyphs';
import { t } from '../../lib/i18n';

type PStr = '0' | '1' | '2' | '3';
// Цвет полосы приоритета — тот же, что и в личных задачах (TaskItem.PRIORITY_BAR):
// один язык цвета на всё приложение, а не отдельная палитра для семьи.
const PRIORITIES: { value: PStr; label: string; dot: string }[] = [
  { value: '0', label: 'Нет', dot: 'bg-border' },
  { value: '1', label: 'Низкий', dot: 'bg-muted' },
  { value: '2', label: 'Средний', dot: 'bg-warning' },
  { value: '3', label: 'Высокий', dot: 'bg-danger' },
];

// Напоминание на день без времени: те же пресеты и подписи, что у личных
// «весь день» задач (TaskEditSheet.formatRemind) — семейные задачи времени не
// имеют, срабатывает утром.
const REMIND_PRESETS_ALLDAY = [1440, 2880, 4320, 10080];
function formatRemindLabel(min: number): string {
  if (min === 10080) return t('за {d}', { d: t('неделю') });
  if (min === 4320) return t('за {d}', { d: t('3 дня') });
  if (min === 2880) return t('за {d}', { d: t('2 дня') });
  return t('за {d}', { d: t('1 день') });
}

interface Props {
  familyId: string;
  open: boolean;
  onClose: () => void;
  task: FamilyTask | null;
  members: FamilyMember[];
}

export function FamilyTaskSheet({ familyId, open, onClose, task, members }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={task ? t('Задача') : t('Новая задача')}>
      <FamilyTaskForm key={task?.id ?? 'new'} familyId={familyId} task={task} members={members} onClose={onClose} />
    </Sheet>
  );
}

function FamilyTaskForm({ familyId, task, members, onClose }: { familyId: string; task: FamilyTask | null; members: FamilyMember[]; onClose: () => void }) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [priority, setPriority] = useState<PStr>(String(task?.priority ?? 0) as PStr);
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [remindBefore, setRemindBefore] = useState<number | null>(task?.remindBefore ?? null);
  const [color, setColor] = useState<string | null>(task?.color ?? null);
  const [assigneeId, setAssigneeId] = useState<string | null>(task?.assigneeId ?? null);
  const alive = members.filter((m) => !m.leftAt);
  const tomorrow = addDaysKey(todayKey(), 1);

  async function save() {
    if (!title.trim()) return;
    const finalRemind = dueDate ? remindBefore : null;
    const data = {
      title: title.trim(),
      notes: notes.trim(),
      priority: Number(priority) as Priority,
      dueDate: dueDate || null,
      dueTime: null,
      remindBefore: finalRemind,
      color,
      assigneeId,
    };
    let saved: { id: string; title: string; dueDate: string | null } | null;
    if (task) {
      await updateFamilyTask(familyId, task.id, data);
      saved = { ...task, ...data };
    } else {
      saved = await createFamilyTask(familyId, data);
    }
    if (saved) {
      if (finalRemind != null) {
        await scheduleReminder({ id: saved.id, title: saved.title, dueDate: saved.dueDate, dueTime: null, remindBefore: finalRemind });
      } else {
        await cancelReminder(saved.id);
      }
    }
    onClose();
  }

  async function remove() {
    if (!task) return;
    if (!window.confirm(t('Удалить задачу?'))) return;
    await cancelReminder(task.id);
    await deleteFamilyTask(familyId, task.id);
    onClose();
  }

  return (
    <div className="space-y-4 pb-2">
      <Field label={t('Что нужно сделать')}>
        <AutoGrowTextarea
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onClear={() => setTitle('')}
          placeholder={t('Название задачи')}
        />
      </Field>
      <Field label={t('Кому')}>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setAssigneeId(null)}
            className={`rounded-full px-3 py-1.5 text-sm ${assigneeId === null ? 'bg-accent-fill text-white' : 'bg-surface-2 text-muted'}`}
          >
            {t('Всем')}
          </button>
          {alive.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setAssigneeId(m.id)}
              className={`rounded-full px-3 py-1.5 text-sm ${assigneeId === m.id ? 'text-white' : 'bg-surface-2 text-muted'}`}
              style={assigneeId === m.id ? { background: m.color } : undefined}
            >
              {m.displayName}
            </button>
          ))}
        </div>
      </Field>
      <Field label={t('Приоритет')}>
        <div className="flex rounded-xl bg-surface-2 p-1">
          {PRIORITIES.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={priority === o.value}
              onClick={() => setPriority(o.value)}
              className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-1 py-2.5 text-sm font-medium transition-all duration-200 ${
                priority === o.value ? 'bg-bg text-text shadow-sm' : 'text-muted active:text-text'
              }`}
            >
              <span className={`size-2 shrink-0 rounded-full ${o.dot}`} />
              {t(o.label)}
            </button>
          ))}
        </div>
      </Field>
      <Field label={t('Цвет')}>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-label={t('Без цвета')}
            onClick={() => setColor(null)}
            className={`flex size-8 items-center justify-center rounded-full border-2 border-dashed border-border text-muted ${color === null ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : ''}`}
          >
            ×
          </button>
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              onClick={() => setColor(c)}
              style={{ background: c }}
              className={`flex size-8 items-center justify-center rounded-full ${color === c ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : ''}`}
            >
              {color === c && <Check size={14} className={isLightColor(c) ? 'text-black' : 'text-white'} />}
            </button>
          ))}
        </div>
      </Field>
      <Field label={t('Срок')}>
        <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        <div className="mt-2 flex flex-wrap gap-2">
          <Chip active={dueDate === todayKey()} onClick={() => setDueDate(todayKey())}>
            {t('Сегодня')}
          </Chip>
          <Chip active={dueDate === tomorrow} onClick={() => setDueDate(tomorrow)}>
            {t('Завтра')}
          </Chip>
          {dueDate && (
            <Chip
              onClick={() => {
                setDueDate('');
                setRemindBefore(null);
              }}
            >
              {t('Убрать')}
            </Chip>
          )}
        </div>
      </Field>
      {dueDate && (
        <Field label={t('Напоминание')}>
          <Select
            value={remindBefore ?? ''}
            onChange={(e) => setRemindBefore(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">{t('Выкл')}</option>
            {[...REMIND_PRESETS_ALLDAY].reverse().map((m) => (
              <option key={m} value={m}>
                {formatRemindLabel(m)}
              </option>
            ))}
            <option value="0">{t('В день задачи')}</option>
          </Select>
          {remindBefore != null && (
            <p className="mt-1.5 text-xs leading-snug text-muted">
              {t('Напоминание приходит утром, в {time}', { time: ALLDAY_REMIND_TIME })}
            </p>
          )}
        </Field>
      )}
      <Field label={t('Детали')}>
        <AutoGrowTextarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('Заметки…')}
          className="min-h-[4.5rem]"
        />
      </Field>
      <div className="flex gap-2 pt-1">
        {task && (
          <Button variant="danger" onClick={() => void remove()}>
            {t('Удалить')}
          </Button>
        )}
        <Button className="flex-1" disabled={!title.trim()} onClick={() => void save()}>
          {t('Сохранить')}
        </Button>
      </div>
    </div>
  );
}
