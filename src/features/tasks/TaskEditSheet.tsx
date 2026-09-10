import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CircleX,
  ImagePlus,
  ListOrdered,
} from 'lucide-react';
import {
  GClose as X,
  GTimer as Timer,
  GCopy as Copy,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { alive, create, remove, uid, update } from '../../db/repo';
import type { ChecklistItem, Priority, Project, Recurrence, Task } from '../../db/types';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { ClearFieldButton, Field, Input, Select } from '../../components/ui/Input';
import { Hint } from '../../components/ui/Hint';
import { useToast } from '../../components/ui/toastContext';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { Switch } from '../../components/ui/Switch';
import { TaskCheck } from '../../components/ui/Checkbox';
import { MicButton } from '../../components/ui/MicButton';
import { addDaysKey, todayKey, WEEKDAY_LABELS } from '../../lib/dates';
import { PRESET_COLORS } from '../../lib/colors';
import { ALLDAY_REMIND_TIME, cancelReminder, scheduleReminder } from '../../lib/push';
import { compressImage } from '../../lib/image';
import { syncTaskPhotos } from '../../lib/taskPhotos';
import { t } from '../../lib/i18n';
import { useAutoCapitalizeTextarea } from '../../lib/useAutoCapitalizeTextarea';
import { usePomodoroActions } from '../focus/pomodoro';
import { ICON } from '../../components/ui/icons';

type RecType = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
type PriorityStr = '0' | '1' | '2' | '3';

// Стили Input для авто-grow textarea названия (#7) — компонент Textarea не
// прокидывает ref, поэтому используем нативный textarea с теми же классами.
const inputBase =
  'w-full rounded-xl bg-surface-2 border border-hairline px-3.5 py-3 text-text placeholder:text-muted outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-2 focus:ring-accent/25';

const PRIORITY_OPTIONS: { value: PriorityStr; label: string }[] = [
  { value: '0', label: 'Нет' },
  { value: '1', label: 'Низкий' },
  { value: '2', label: 'Средний' },
  { value: '3', label: 'Высокий' },
];

const REC_OPTIONS: { value: RecType; label: string }[] = [
  { value: 'none', label: 'Нет' },
  { value: 'daily', label: 'День' },
  { value: 'weekly', label: 'Неделя' },
  { value: 'monthly', label: 'Месяц' },
  { value: 'yearly', label: 'Год' },
];

const REC_INTERVAL_LABELS: Record<Exclude<RecType, 'none'>, string> = {
  daily: 'Интервал (дней)',
  weekly: 'Интервал (недель)',
  monthly: 'Интервал (месяцев)',
  yearly: 'Интервал (лет)',
};

// Длительность — от 5 минут до 24 часов (мелкий шаг в начале, крупный дальше).
const DURATION_PRESETS = [
  5, 10, 15, 20, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720, 900, 1080, 1440,
];
// Напоминание — за сколько до начала. Дни нужны не для красоты: подготовиться
// к чему-то за пару суток нельзя, если самый дальний вариант — двадцать четыре
// часа. Ровно этого не хватало владельцу.
const REMIND_PRESETS = [5, 10, 15, 30, 45, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080];
// У задачи без времени («завтра сдать отчёт») минуты и часы бессмысленны: «за
// 15 минут» до чего? Остаются дни, и приходит напоминание утром.
const REMIND_PRESETS_ALLDAY = [1440, 2880, 4320, 10080];

/** Подпись варианта напоминания. Дни словами: «за 24 ч» вместо «за день» —
 *  это подпись для машины, человек так о сроках не думает. */
function formatRemind(min: number): string {
  if (min === 10080) return t('неделю');
  if (min === 4320) return t('3 дня');
  if (min === 2880) return t('2 дня');
  if (min === 1440) return t('1 день');
  return formatDuration(min);
}

/** Человекочитаемая длительность: «15м», «1ч», «1ч 30м». */
function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return t('{m}\u00A0мин', { m });
  return m === 0 ? t('{h}\u00A0ч', { h }) : t('{h}\u00A0ч {m}\u00A0мин', { h, m });
}

type TaskEditProps = {
  onClose: () => void;
  task?: Task | null;
  defaults?: { projectId?: string | null; goalId?: string | null; dueDate?: string | null };
};

/** Шит создания/редактирования задачи. task=null → создание с defaults. */
// Потолок суммарного веса снимков одной задачи (в символах dataURL).
//
// Снимки лежат в строке задачи, а строку целиком забирает синхронизация: на
// сервере шифротекст ложится в колонку с лимитом 2 МБ. Задача тяжелее этого не
// уедет на второе устройство никогда. Держим с запасом на шифрование и на
// остальные поля задачи.
const PHOTOS_MAX_CHARS = 1_200_000;

export function TaskEditSheet({ open, ...rest }: TaskEditProps & { open: boolean }) {
  // Форма монтируется заново на каждое открытие: состояние инициализируется
  // из props, поэтому сброс через эффект не нужен.
  if (!open) return null;
  return <TaskEditForm {...rest} />;
}

function TaskEditForm({ onClose, task, defaults }: TaskEditProps) {
  const projectsRaw = useLiveQuery(
    async () =>
      alive(await db.projects.toArray())
        .filter((p) => !p.archivedAt)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [],
  );
  // Стабильная ссылка для useMemo ниже: «?? []» на каждый рендер давал бы
  // новую идентичность и пересчёт orderedProjects впустую.
  const projects = useMemo(() => projectsRaw ?? [], [projectsRaw]);
  const goals =
    useLiveQuery(
      async () => alive(await db.goals.toArray()).filter((g) => g.status === 'active'),
      [],
    ) ?? [];

  const toast = useToast();
  const navigate = useNavigate();
  // Без тикающего времени: форме нужен только запуск фокуса по задаче, а подписка на
  // время перерисовывала бы форму дважды в секунду весь сеанс.
  const pomodoro = usePomodoroActions();
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  // Заглавная в начале строки и после «2. » — как в заметках. Клавиатура iOS
  // сама этого не делает: она смотрит на пунктуацию, а в списке точек нет.
  useAutoCapitalizeTextarea(titleRef);
  useAutoCapitalizeTextarea(notesRef);

  const handleFocus = () => {
    if (!task) return;
    pomodoro.start(task.id, title.trim() || task.title);
    onClose();
    navigate('/more/focus');
  };

  const rec = task?.recurrence;
  const [title, setTitle] = useState(task?.title ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [tagsText, setTagsText] = useState(task ? task.tags.join(', ') : '');
  const [projectId, setProjectId] = useState<string | null>(
    task ? task.projectId : (defaults?.projectId ?? null),
  );
  const [goalId, setGoalId] = useState<string | null>(
    task ? task.goalId : (defaults?.goalId ?? null),
  );
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 0);
  const [temporary, setTemporary] = useState(Boolean(task?.temporary));
  const [dueDate, setDueDate] = useState<string | null>(
    task ? task.dueDate : (defaults?.dueDate ?? null),
  );
  // Начало окна для срока-периода («с 10 по 25»). null — обычный срок.
  const [startDate, setStartDate] = useState<string | null>(task?.startDate ?? null);
  const [dueTime, setDueTime] = useState<string | null>(task?.dueTime ?? null);
  const [duration, setDuration] = useState<number | null>(task?.duration ?? null);
  const [remindBefore, setRemindBefore] = useState<number | null>(task?.remindBefore ?? null);
  const [recType, setRecType] = useState<RecType>(rec?.type ?? 'none');
  const [recInterval, setRecInterval] = useState(String(rec?.interval ?? 1));
  const [recWeekdays, setRecWeekdays] = useState<number[]>(
    rec?.type === 'weekly' ? [...rec.weekdays] : [],
  );
  const [recDayOfMonth, setRecDayOfMonth] = useState(
    String(rec?.type === 'monthly' ? rec.dayOfMonth : 1),
  );
  const [checklist, setChecklist] = useState<ChecklistItem[]>(
    task ? task.checklist.map((i) => ({ ...i })) : [],
  );
  const [newItem, setNewItem] = useState('');
  const [photos, setPhotos] = useState<string[]>(task?.photos ? [...task.photos] : []);
  // Просмотр фото на весь экран (null — закрыт).
  const [viewPhoto, setViewPhoto] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Проекты в порядке иерархии: верхний уровень, за ним его подпроекты с отступом.
  const orderedProjects = useMemo(() => {
    const ids = new Set(projects.map((p) => p.id));
    const tops = projects.filter((p) => !p.parentId || !ids.has(p.parentId));
    const out: { p: Project; depth: number }[] = [];
    for (const top of tops) {
      out.push({ p: top, depth: 0 });
      for (const c of projects.filter((x) => x.parentId === top.id)) out.push({ p: c, depth: 1 });
    }
    return out;
  }, [projects]);

  // Инлайн-создание проекта прямо из шита задачи (#1).
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectColor, setNewProjectColor] = useState(PRESET_COLORS[0]);
  const [newProjectEmoji, setNewProjectEmoji] = useState('📁');


  // Авто-подгон высоты поля названия под содержимое (#7). Реагирует на
  // программные изменения title (mic/инициализация) и на открытие шита.
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  // Авто-подгон высоты поля заметок — поле растёт за текстом (без внутреннего
  // скролла), а лента шита держит курсор в зоне видимости: текст больше не
  // уходит в невидимый край, и при создании, и при просмотре виден целиком.
  useEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [notes]);

  const buildRecurrence = (): Recurrence | null => {
    const interval = Math.max(1, parseInt(recInterval, 10) || 1);
    switch (recType) {
      case 'none':
        return null;
      case 'daily':
        return { type: 'daily', interval };
      case 'weekly':
        return { type: 'weekly', interval, weekdays: [...recWeekdays].sort((a, b) => a - b) };
      case 'monthly':
        return {
          type: 'monthly',
          interval,
          dayOfMonth: Math.min(31, Math.max(1, parseInt(recDayOfMonth, 10) || 1)),
        };
      case 'yearly':
        return { type: 'yearly', interval };
    }
  };

  const savingRef = useRef(false);
  const handleSave = async () => {
    if (savingRef.current) return; // защита от дабл-тапа: не плодим дубликаты
    savingRef.current = true;
    try {
      // Перепутанные концы периода не ошибка, а лишний вопрос — меняем местами.
      const range =
        dueDate && startDate
          ? startDate <= dueDate
            ? { startDate, dueDate }
            : { startDate: dueDate, dueDate: startDate }
          : { startDate: null, dueDate };
      const data = {
        title: title.trim(),
        notes: notes.trim(),
        projectId,
        goalId,
        priority,
        temporary,
        dueDate: range.dueDate,
        startDate: range.startDate,
        dueTime: dueDate ? dueTime : null,
        duration: dueDate ? duration : null,
        remindBefore: dueDate ? remindBefore : null,
        checklist,
        photos,
        recurrence: buildRecurrence(),
        tags: tagsText
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      };
      let savedId: string;
      if (task) {
        await update(db.tasks, task.id, data);
        savedId = task.id;
      } else {
        const created = await create(db.tasks, { ...data, completedAt: null, sortOrder: Date.now() });
        savedId = created.id;
      }
      // Снимки раскладываем кусками в свою таблицу — параллельно тому, что они
      // остались в строке задачи. Пока второе устройство может быть на старой
      // версии, поле photos убирать нельзя: применяя такую задачу, оно затёрло
      // бы ею свои фотографии. Строку эта запись не трогает.
      void syncTaskPhotos(savedId, photos);
      // Поставить/обновить пуш-напоминание (внутри само снимет, если срок/время убраны).
      void scheduleReminder({
        id: savedId,
        title: data.title,
        dueDate: range.dueDate,
        dueTime: data.dueTime,
        remindBefore: data.remindBefore,
      });
      onClose();
    } finally {
      savingRef.current = false;
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    if (!window.confirm(t('Удалить задачу?'))) return;
    void cancelReminder(task.id);
    await remove(db.tasks, task.id);
    onClose();
  };

  const handleCreateProject = async () => {
    const name = newProjectName.trim();
    if (!name) return;
    const project = await create(db.projects, {
      name,
      color: newProjectColor,
      emoji: newProjectEmoji.trim() || '📁',
      sortOrder: Date.now(),
      archivedAt: null,
    });
    setProjectId(project.id);
    setShowNewProject(false);
    setNewProjectName('');
    setNewProjectColor(PRESET_COLORS[0]);
    setNewProjectEmoji('📁');
  };

  const addChecklistItem = () => {
    const text = newItem.trim();
    if (!text) return;
    setChecklist((items) => [...items, { id: uid(), text, done: false }]);
    setNewItem('');
  };

  // Добавление фото: сжимаем в JPEG dataURL (как в «Местах»/чате), чтобы не
  // раздувать IndexedDB и полезную нагрузку синка.
  const addPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    const added: string[] = [];
    // Считаем суммарный вес прямо здесь: снимки лежат в строке самой задачи, а
    // строку целиком забирает синхронизация. Перерасти лимит сервера — значит
    // получить задачу, которая не уедет на второе устройство никогда. Лучше
    // сказать об этом сразу, чем сохранить и молчать.
    let weight = photos.reduce((n, p) => n + p.length, 0);
    let refused = 0;
    for (const f of Array.from(files).slice(0, 10)) {
      try {
        const photo = await compressImage(f, 1280, 0.72);
        if (weight + photo.length > PHOTOS_MAX_CHARS) {
          refused++;
          continue;
        }
        weight += photo.length;
        added.push(photo);
      } catch {
        /* нечитаемый файл — пропускаем */
      }
    }
    if (added.length) setPhotos((prev) => [...prev, ...added]);
    if (refused > 0) {
      toast(
        t('Не добавлено фото: {n}. Задача не влезет в синхронизацию — часть снимков лучше положить в заметку', {
          n: refused,
        }),
      );
    }
  };

  const handleNewItemKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addChecklistItem();
    }
  };

  // Enter в поле названия не сабмитит — даём перенос строки (#7).
  const handleTitleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) e.stopPropagation();
  };

  // Автонумерация в заметках: Enter после строки «N. текст» добавляет «(N+1). »;
  // Enter на пустом пункте «N. » — выходит из списка (убирает маркер).
  const handleNotesKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const ta = e.currentTarget;
    const { selectionStart, selectionEnd, value } = ta;
    if (selectionStart !== selectionEnd) return; // есть выделение — обычный Enter
    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const line = value.slice(lineStart, selectionStart);
    const m = /^(\s*)(\d+)\.\s(.*)$/.exec(line);
    if (!m) return; // строка не вида «N. …» — обычный перенос
    e.preventDefault();
    const [, indent, numStr, rest] = m;
    if (rest.trim() === '') {
      const next = value.slice(0, lineStart) + value.slice(selectionStart);
      setNotes(next);
      requestAnimationFrame(() => ta.setSelectionRange(lineStart, lineStart));
      return;
    }
    const insert = `\n${indent}${Number(numStr) + 1}. `;
    const next = value.slice(0, selectionStart) + insert + value.slice(selectionEnd);
    setNotes(next);
    const pos = selectionStart + insert.length;
    requestAnimationFrame(() => ta.setSelectionRange(pos, pos));
  };

  const copyText = (text: string) => {
    if (!text) return;
    void navigator.clipboard.writeText(text);
    toast(t('Скопировано'));
  };

  const tomorrow = addDaysKey(todayKey(), 1);

  return (
    <Sheet open onClose={onClose} title={task ? t('Задача') : t('Новая задача')}>
      <div className="flex flex-col gap-4 pb-2">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-muted">{t('Название')}</span>
            <button
              type="button"
              aria-label={t('Скопировать название')}
              onClick={() => copyText(title)}
              className="-mr-1 p-1 text-muted active:opacity-60"
            >
              <Copy size={ICON.inline} />
            </button>
          </div>
          <div className="flex items-start gap-2">
            <div className="relative min-w-0 flex-1">
              {title.length > 0 && (
                <ClearFieldButton onClick={() => setTitle('')} className="top-3" />
              )}
              <textarea
                ref={titleRef}
                rows={1}
                value={title}
                placeholder={t('Что нужно сделать?')}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={handleTitleKey}
                className={`${inputBase} resize-none overflow-hidden`}
                style={title ? { paddingLeft: '2.5rem' } : undefined}
              />
            </div>
            <MicButton
              onText={(spoken) => setTitle((prev) => (prev ? `${prev} ${spoken}` : spoken))}
            />
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-muted">{t('Заметки')}</span>
            <button
              type="button"
              aria-label={t('Скопировать заметки')}
              onClick={() => copyText(notes)}
              className="-mr-1 p-1 text-muted active:opacity-60"
            >
              <Copy size={ICON.inline} />
            </button>
          </div>
          <div className="flex items-start gap-2">
            <div className="relative min-w-0 flex-1">
              {notes.length > 0 && (
                <ClearFieldButton onClick={() => setNotes('')} className="top-3" />
              )}
              <textarea
                ref={notesRef}
                rows={2}
                value={notes}
                placeholder={t('Детали…')}
                onChange={(e) => setNotes(e.target.value)}
                onKeyDown={handleNotesKey}
                className={`${inputBase} resize-none overflow-hidden whitespace-pre-wrap font-mono`}
                style={notes ? { paddingLeft: '2.5rem' } : undefined}
              />
            </div>
            <MicButton
              onText={(spoken) => setNotes((prev) => (prev ? `${prev} ${spoken}` : spoken))}
            />
          </div>
          <Hint
            id="task-notes-tricks"
            title={t('Удобный ввод')}
            className="mt-2"
            items={[
              { icon: ListOrdered, text: <>{t('Начните строку с «1. » — Enter продолжит нумерацию сам')}</> },
              { icon: CircleX, text: <>{t('Крестик в начале текста стирает всё поле')}</> },
            ]}
          />
        </div>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">{t('Фото')}</span>
          <div className="flex flex-wrap gap-2">
            {photos.map((src, i) => (
              <div key={i} className="relative">
                <button type="button" onClick={() => setViewPhoto(src)} aria-label={t('Открыть фото')}>
                  <img
                    src={src}
                    alt=""
                    className="size-20 rounded-xl border border-hairline object-cover"
                  />
                </button>
                <button
                  type="button"
                  aria-label={t('Удалить фото')}
                  onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-full border border-border bg-elevated text-muted active:opacity-60"
                >
                  <X size={ICON.inline} />
                </button>
              </div>
            ))}
            <button
              type="button"
              aria-label={t('Добавить фото')}
              onClick={() => photoInputRef.current?.click()}
              className="flex size-20 items-center justify-center rounded-xl border border-dashed border-border text-muted active:opacity-60"
            >
              <ImagePlus size={ICON.header} />
            </button>
          </div>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              void addPhotos(e.target.files);
              e.target.value = ''; // позволяет выбрать те же файлы повторно
            }}
          />
        </div>

        <Field label={t('Теги')}>
          <Input
            value={tagsText}
            placeholder={t('через запятую: работа, дом')}
            onChange={(e) => setTagsText(e.target.value)}
            onClear={() => setTagsText('')}
          />
        </Field>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-muted">{t('Проект')}</span>
            {!showNewProject && (
              <button
                type="button"
                className="text-sm font-medium text-accent"
                onClick={() => setShowNewProject(true)}
              >
                {t('+ Новый')}
              </button>
            )}
          </div>
          {showNewProject ? (
            <div className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface p-3">
              <div className="flex items-center gap-2">
                <Input
                  value={newProjectEmoji}
                  placeholder="📁"
                  onChange={(e) => setNewProjectEmoji(e.target.value)}
                  className="w-14! shrink-0 text-center"
                />
                <Input
                  value={newProjectName}
                  placeholder={t('Название проекта')}
                  autoFocus
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onClear={() => setNewProjectName('')}
                  className="min-w-0 flex-1"
                />
              </div>
              <div className="flex flex-wrap gap-2.5">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={t('Цвет {c}', { c })}
                    onClick={() => setNewProjectColor(c)}
                    className="size-7 rounded-full transition-transform active:scale-90"
                    style={{
                      backgroundColor: c,
                      outline: newProjectColor === c ? `2px solid ${c}` : 'none',
                      outlineOffset: '2px',
                    }}
                  />
                ))}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={() => {
                    setShowNewProject(false);
                    setNewProjectName('');
                  }}
                >
                  {t('Отмена')}
                </Button>
                <Button
                  className="flex-1"
                  disabled={!newProjectName.trim()}
                  onClick={handleCreateProject}
                >
                  {t('Создать')}
                </Button>
              </div>
            </div>
          ) : (
            <Select value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value || null)}>
              <option value="">{t('Без проекта')}</option>
              {orderedProjects.map(({ p, depth }) => (
                <option key={p.id} value={p.id}>
                  {depth > 0 ? '   ↳ ' : ''}
                  {p.emoji} {p.name}
                </option>
              ))}
            </Select>
          )}
        </div>

        <Field label={t('Цель')}>
          <Select value={goalId ?? ''} onChange={(e) => setGoalId(e.target.value || null)}>
            <option value="">{t('Без цели')}</option>
            {goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t('Приоритет')}>
          <SegmentedControl
            options={PRIORITY_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
            value={String(priority) as PriorityStr}
            onChange={(v) => setPriority(Number(v) as Priority)}
          />
        </Field>

        {/* Разовое поручение. Пометка ставится руками, а не угадывается по
            сроку: дедлайн у постоянной задачи бывает не реже, чем у разовой,
            и догадка врала бы ровно на них. */}
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="min-w-0">
            <span className="block text-sm font-medium">{t('Временная')}</span>
            <span className="block text-xs leading-snug text-muted">
              {t('Соберётся отдельной группой внизу проекта')}
            </span>
          </span>
          <Switch
            checked={temporary}
            onChange={setTemporary}
            label={t('Временная')}
          />
        </div>

        <div>
          {/* Период: «сдать с 10 по 25». Начало — отдельным полем над сроком,
              срок остаётся дедлайном (просрочка и напоминание — по нему). */}
          {startDate !== null && (
            <Field label={t('Начало')} className="mb-3">
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value || null)}
              />
            </Field>
          )}
          <Field label={startDate !== null ? t('Сдать до') : t('Срок')}>
            <Input
              type="date"
              value={dueDate ?? ''}
              onChange={(e) => setDueDate(e.target.value || null)}
            />
          </Field>
          <div className="mt-2">
            <ChipRow>
              <Chip active={dueDate === todayKey()} onClick={() => setDueDate(todayKey())}>
                {t('Сегодня')}
              </Chip>
              <Chip active={dueDate === tomorrow} onClick={() => setDueDate(tomorrow)}>
                {t('Завтра')}
              </Chip>
              <Chip
                active={startDate !== null}
                onClick={() => {
                  if (startDate !== null) {
                    setStartDate(null);
                    return;
                  }
                  // Типовой период начинается сегодня; без дедлайна период не
                  // имеет смысла — ставим и его, человек поправит оба поля.
                  if (!dueDate) setDueDate(todayKey());
                  setStartDate(todayKey());
                }}
              >
                {t('Период')}
              </Chip>
              <Chip
                onClick={() => {
                  setDueDate(null);
                  setDueTime(null);
                  setStartDate(null);
                }}
              >
                {t('Убрать')}
              </Chip>
            </ChipRow>
          </div>
        </div>

        {dueDate && (
          <>
            <Field label={t('Время начала')}>
              <div className="flex items-center gap-2">
                <Input
                  type="time"
                  className="flex-1"
                  value={dueTime ?? ''}
                  onChange={(e) => setDueTime(e.target.value || null)}
                />
                {dueTime && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      setDueTime(null);
                    }}
                    className="shrink-0 rounded-xl border border-border px-3.5 py-3 text-sm text-muted active:opacity-60"
                  >
                    {t('Убрать')}
                  </button>
                )}
              </div>
            </Field>
            <Field label={t('Длительность')}>
              <Select
                value={duration ?? ''}
                onChange={(e) => setDuration(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{t('Нет')}</option>
                {DURATION_PRESETS.map((m) => (
                  <option key={m} value={m}>
                    {formatDuration(m)}
                  </option>
                ))}
              </Select>
            </Field>
            {/* Напоминание доступно любой задаче со сроком, а не только той, у
                которой задано время. «Завтра сдать отчёт» пишут без часа — и
                именно такой задаче напоминание нужнее всего; раньше поле для
                неё просто не показывалось. */}
            <Field label={t('Напоминание')}>
              <Select
                value={remindBefore ?? ''}
                onChange={(e) =>
                  setRemindBefore(e.target.value === '' ? null : Number(e.target.value))
                }
              >
                <option value="">{t('Выкл')}</option>
                <option value="0">{dueTime ? t('Вовремя') : t('В день задачи')}</option>
                {(dueTime ? REMIND_PRESETS : REMIND_PRESETS_ALLDAY).map((m) => (
                  <option key={m} value={m}>
                    {t('за {d}', { d: formatRemind(m) })}
                  </option>
                ))}
              </Select>
              {!dueTime && remindBefore != null && (
                <p className="mt-1.5 text-xs leading-snug text-muted">
                  {t('У задачи без времени напоминание приходит утром, в {time}', {
                    time: ALLDAY_REMIND_TIME,
                  })}
                </p>
              )}
            </Field>
          </>
        )}

        <Field label={t('Повторение')}>
          <SegmentedControl
            options={REC_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
            value={recType}
            onChange={setRecType}
          />
        </Field>

        {recType !== 'none' && (
          <Field label={t(REC_INTERVAL_LABELS[recType])}>
            <Input
              type="number"
              min={1}
              inputMode="numeric"
              value={recInterval}
              onChange={(e) => setRecInterval(e.target.value)}
            />
          </Field>
        )}

        {recType === 'weekly' && (
          <ChipRow>
            {WEEKDAY_LABELS.map((label, i) => {
              const day = i + 1;
              const on = recWeekdays.includes(day);
              return (
                <Chip
                  key={day}
                  active={on}
                  onClick={() =>
                    setRecWeekdays(
                      on ? recWeekdays.filter((d) => d !== day) : [...recWeekdays, day],
                    )
                  }
                >
                  {t(label)}
                </Chip>
              );
            })}
          </ChipRow>
        )}

        {recType === 'monthly' && (
          <Field label={t('День месяца')}>
            <Input
              type="number"
              min={1}
              max={31}
              inputMode="numeric"
              value={recDayOfMonth}
              onChange={(e) => setRecDayOfMonth(e.target.value)}
            />
          </Field>
        )}

        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">{t('Чеклист')}</span>
          {checklist.map((item) => (
            <div key={item.id} className="flex items-center gap-2.5 py-1">
              <TaskCheck
                size={20}
                checked={item.done}
                onChange={() =>
                  setChecklist((arr) =>
                    arr.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)),
                  )
                }
              />
              <span className={`flex-1 text-sm ${item.done ? 'text-muted line-through' : ''}`}>
                {item.text}
              </span>
              <button
                aria-label={t('Удалить пункт')}
                className="shrink-0 p-1 text-muted"
                onClick={() => setChecklist((arr) => arr.filter((i) => i.id !== item.id))}
              >
                <X size={ICON.action} />
              </button>
            </div>
          ))}
          <Input
            className="mt-1"
            value={newItem}
            placeholder={t('Добавить пункт')}
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={handleNewItemKey}
            onClear={() => setNewItem('')}
          />
        </div>

        {task && (
          <Button
            variant="secondary"
            className="flex w-full items-center justify-center gap-1.5"
            onClick={handleFocus}
          >
            <Timer size={ICON.action} /> {t('Запустить фокус')}
          </Button>
        )}

        <div className="mt-1 flex gap-2">
          {task && (
            <Button variant="danger" onClick={handleDelete}>
              {t('Удалить')}
            </Button>
          )}
          <Button className="flex-1" disabled={!title.trim()} onClick={handleSave}>
            {t('Сохранить')}
          </Button>
        </div>
      </div>

      {/* Просмотр фото на весь экран — поверх шита, закрытие тапом. */}
      {viewPhoto && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/90 p-4"
          onClick={() => setViewPhoto(null)}
        >
          <img
            src={viewPhoto}
            alt=""
            className="max-h-full max-w-full rounded-xl object-contain"
          />
        </div>
      )}
    </Sheet>
  );
}
