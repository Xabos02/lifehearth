import { useRef, useState, type ChangeEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Button } from '../../components/ui/Button';
import { AutoGrowTextarea, Field, Input, Select } from '../../components/ui/Input';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { Sheet } from '../../components/ui/Sheet';
import { db } from '../../db/db';
import { alive, create, now, remove, update } from '../../db/repo';
import { t } from '../../lib/i18n';
import type { LearningItem, LearningKind } from '../../db/types';

type EditableStatus = 'planned' | 'inProgress' | 'done';
type ProgressUnit = LearningItem['progressUnit'];

/** Подписи поля «сколько всего» под выбранную единицу. Проценты сюда не
 *  попадают: у них цель всегда сто, и поле не показывается. */
const TARGET_LABEL: Record<Exclude<ProgressUnit, 'percent'>, string> = {
  pages: 'Всего страниц',
  lessons: 'Всего уроков',
  hours: 'Всего часов',
};

const TARGET_HINT: Record<Exclude<ProgressUnit, 'percent'>, string> = {
  pages: 'Например, 340',
  lessons: 'Например, 20',
  hours: 'Например, 40',
};

interface Props {
  open: boolean;
  onClose: () => void;
  item?: LearningItem | null;
}

export function LearningItemSheet({ open, onClose, item }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title={item ? t('Материал') : t('Новый материал')}>
      {/* Sheet при !open возвращает null → форма размонтируется и при
          следующем открытии инициализируется заново из item. */}
      <ItemForm key={item?.id ?? 'new'} item={item ?? null} onClose={onClose} />
    </Sheet>
  );
}

function ItemForm({ item, onClose }: { item: LearningItem | null; onClose: () => void }) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [author, setAuthor] = useState(item?.author ?? '');
  const [kind, setKind] = useState<LearningKind>(item?.kind ?? 'book');
  const [status, setStatus] = useState<EditableStatus>(
    item ? (item.status === 'dropped' ? 'done' : item.status) : 'planned',
  );
  const [unit, setUnit] = useState<ProgressUnit>(item?.progressUnit ?? 'percent');
  const [targetStr, setTargetStr] = useState(
    item && item.progressUnit !== 'percent' ? String(item.progressTarget) : '',
  );
  const [due, setDue] = useState(item?.dueDate ?? '');
  const [goalId, setGoalId] = useState(item?.goalId ?? '');
  const [notes, setNotes] = useState(item?.notes ?? '');

  const goalRows = useLiveQuery(
    () => db.goals.where('status').equals('active').toArray(),
    [],
  );
  const goals = alive(goalRows ?? []);

  // Для языка прогресс удобнее в процентах — подсказываем единицу при выборе.
  const handleKindChange = (next: LearningKind) => {
    setKind(next);
    if (next === 'language') setUnit('percent');
  };

  const savingRef = useRef(false);
  const handleSave = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    if (savingRef.current) return; // защита от дабл-тапа
    savingRef.current = true;
    try {
      const progressTarget = unit === 'percent' ? 100 : Math.max(1, Number(targetStr) || 1);
      const base = {
        title: trimmed,
        author: author.trim(),
        kind,
        status,
        goalId: goalId || null,
        progressUnit: unit,
        progressTarget,
        notes: notes.trim(),
        dueDate: due || null,
      };
      if (item) {
        const changes: Partial<Omit<LearningItem, 'id' | 'createdAt'>> = {
          ...base,
          progressCurrent: Math.min(item.progressCurrent, progressTarget),
        };
        if (status === 'inProgress' && !item.startedAt) changes.startedAt = now();
        if (status === 'done' && !item.finishedAt) changes.finishedAt = now();
        await update(db.learningItems, item.id, changes);
      } else {
        await create(db.learningItems, {
          ...base,
          progressCurrent: 0,
          startedAt: status !== 'planned' ? now() : null,
          finishedAt: status === 'done' ? now() : null,
        });
      }
      onClose();
    } finally {
      savingRef.current = false;
    }
  };

  const handleDelete = async () => {
    if (!item) return;
    if (!window.confirm(t('Удалить материал?'))) return;
    await remove(db.learningItems, item.id);
    onClose();
  };

  return (
    <div className="space-y-4 pb-2">
        <Field label={t('Название')}>
          <AutoGrowTextarea
            value={title}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setTitle(e.target.value)}
            onClear={() => setTitle('')}
            placeholder={t('Например, «Атомные привычки»')}
          />
        </Field>
        <Field label={t('Автор')}>
          <Input
            value={author}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setAuthor(e.target.value)}
            placeholder={t('Автор или источник')}
          />
        </Field>
        <Field label={t('Тип')}>
          <SegmentedControl<LearningKind>
            options={[
              { value: 'book', label: t('Книга') },
              { value: 'course', label: t('Курс') },
              { value: 'article', label: t('Статья') },
            ]}
            value={kind}
            onChange={handleKindChange}
          />
          <div className="mt-2">
            <SegmentedControl<LearningKind>
              options={[
                { value: 'video', label: t('Видео') },
                { value: 'research', label: t('Исследование') },
                { value: 'language', label: t('Язык') },
              ]}
              value={kind}
              onChange={handleKindChange}
            />
          </div>
        </Field>
        <Field label={t('Статус')}>
          <SegmentedControl<EditableStatus>
            options={[
              { value: 'planned', label: t('В планах') },
              { value: 'inProgress', label: t('В процессе') },
              { value: 'done', label: t('Завершено') },
            ]}
            value={status}
            onChange={setStatus}
          />
        </Field>
        <Field label={t('Единица прогресса')}>
          <SegmentedControl<ProgressUnit>
            options={[
              { value: 'percent', label: t('%') },
              { value: 'pages', label: t('Страницы') },
              { value: 'lessons', label: t('Уроки') },
              { value: 'hours', label: t('Часы') },
            ]}
            value={unit}
            onChange={setUnit}
          />
        </Field>
        {unit !== 'percent' && (
          <Field label={t(TARGET_LABEL[unit])}>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={targetStr}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTargetStr(e.target.value)}
              placeholder={t(TARGET_HINT[unit])}
            />
          </Field>
        )}
        <Field label={t('Успеть до')}>
          <Input
            type="date"
            value={due}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setDue(e.target.value)}
          />
          <p className="mt-1.5 px-1 text-xs text-muted">
            {t(
              'Со сроком приложение считает, сколько нужно в неделю, и предупреждает, когда начинаешь отставать.',
            )}
          </p>
        </Field>
        <Field label={t('Цель')}>
          <Select
            value={goalId}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => setGoalId(e.target.value)}
          >
            <option value="">{t('Без цели')}</option>
            {goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('Заметки')}>
          <AutoGrowTextarea
            value={notes}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
            placeholder={t('Мысли, цитаты, выводы…')}
            className="min-h-[4.5rem]"
          />
        </Field>
        <div className="flex gap-2 pt-1">
          {item && (
            <Button variant="danger" onClick={() => void handleDelete()}>
              {t('Удалить')}
            </Button>
          )}
          <Button
            className="flex-1"
            disabled={!title.trim()}
            onClick={() => void handleSave()}
          >
            {t('Сохранить')}
          </Button>
      </div>
    </div>
  );
}
