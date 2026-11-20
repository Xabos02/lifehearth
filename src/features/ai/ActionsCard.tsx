import { Link } from 'react-router';
import type { AiAction, AiActionKind } from '../../db/types';
import { GFaCheck } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { SECTION_BY_ID } from '../../lib/sections';
import { t } from '../../lib/i18n';

// Что ассистент изменил в данных за ответ — под ответом, с отменой.
// Удаление он только предлагает: выполняется кнопкой (решение Влада 20.11).
// Вид — вариант А канвы design/ai-actions (выбор Влада 20.11): карточка-список,
// у каждой записи своя отмена, удаление — строкой в две строки (на 320 px в
// одну строку название сжималось до «Стар…»).

/** Раздел записи: значок строки и куда ведёт тап. */
const SECTION_OF: Record<AiActionKind, string> = {
  task: 'tasks',
  project: 'tasks',
  note: 'notes',
  habit: 'habits',
  goal: 'goals',
  workout: 'health',
  template: 'health',
  expense: 'finance',
  income: 'finance',
  savings: 'finance',
  deposit: 'finance',
};

/** Подпись строки: род у каждого слова свой, поэтому — фразой целиком. */
const ACTION_LABELS: Record<string, string> = {
  'create.task': 'Новая задача',
  'create.project': 'Новый проект',
  'create.note': 'Новая заметка',
  'create.habit': 'Новая привычка',
  'create.goal': 'Новая цель',
  'create.workout': 'Тренировка записана',
  'create.template': 'Новый шаблон тренировки',
  'create.expense': 'Новый расход',
  'create.income': 'Новый доход',
  'create.savings': 'Новая копилка',
  'create.deposit': 'Пополнение копилки',
  'update.task': 'Задача изменена',
  'complete.task': 'Задача выполнена',
  'delete.task': 'Задача удалена',
  'delete.note': 'Заметка удалена',
  'delete.template': 'Шаблон удалён',
  'delete.expense': 'Расход удалён',
  'delete.income': 'Доход удалён',
};

/** Вопрос перед удалением — глагол и что именно (PROTOCOL §5.9). */
const CONFIRM_LABELS: Record<string, string> = {
  task: 'Удалить задачу?',
  note: 'Удалить заметку?',
  template: 'Удалить шаблон?',
  expense: 'Удалить расход?',
  income: 'Удалить доход?',
};

const actionLabel = (a: AiAction) => t(ACTION_LABELS[`${a.op}.${a.kind}`] ?? a.kind);

function actionLink(a: AiAction): string {
  if (a.kind === 'note') return `/notes/${a.ids[0]}`;
  if (a.kind === 'goal') return `/goals/${a.ids[0]}`;
  return SECTION_BY_ID.get(SECTION_OF[a.kind])?.to ?? '/home';
}

export interface ActionsCardProps {
  actions: AiAction[];
  onUndo: (i: number) => void;
  onConfirm: (i: number) => void;
  onKeep: (i: number) => void;
}

function KindIcon({ a, tone = 'accent' }: { a: AiAction; tone?: 'accent' | 'danger' | 'muted' }) {
  const Icon = SECTION_BY_ID.get(SECTION_OF[a.kind])?.icon ?? GFaCheck;
  const cls =
    tone === 'danger'
      ? 'border-danger/30 bg-danger/10 text-danger'
      : tone === 'muted'
        ? 'border-lh-border bg-lh-surface-2 text-lh-text-secondary'
        : 'border-lh-accent-border bg-lh-accent-dim text-lh-accent';
  return (
    <span aria-hidden className={`grid size-8 shrink-0 place-items-center rounded-full border ${cls}`}>
      <Icon size={ICON.action} />
    </span>
  );
}

const textBtn =
  'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 text-xs font-medium active:opacity-70';

/** Кнопки строки по состоянию действия. */
function RowControls({ a, i, onUndo, onConfirm, onKeep }: { a: AiAction; i: number } & Omit<ActionsCardProps, 'actions'>) {
  if (a.state === 'pending') {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <button className={`${textBtn} text-lh-text`} onClick={() => onKeep(i)}>
          {t('Оставить')}
        </button>
        <button className={`${textBtn} border border-danger/30 text-danger`} onClick={() => onConfirm(i)}>
          {t('Удалить')}
        </button>
      </div>
    );
  }
  if (a.state === 'undone') {
    return <span className="shrink-0 px-2.5 text-xs text-lh-text-secondary">{a.op === 'delete' ? t('Не удалено') : t('Отменено')}</span>;
  }
  return (
    <button className={`${textBtn} text-lh-accent`} onClick={() => onUndo(i)}>
      {a.op === 'delete' ? t('Вернуть') : t('Отменить')}
    </button>
  );
}

/** Карточка-список: каждая запись строкой со своей отменой; тап по записи
 *  ведёт в её раздел. */
export function ActionsCard({ actions, ...h }: ActionsCardProps) {
  return (
    <div data-ai-actions className="overflow-hidden rounded-[12px] border border-lh-border bg-lh-surface">
      <p className="px-3.5 pt-2.5 text-2xs font-semibold tracking-wide text-lh-text-secondary uppercase">
        {t('Изменения в данных')}
      </p>
      <ul className="divide-y divide-lh-border">
        {actions.map((a, i) => {
          const pending = a.state === 'pending';
          return (
            <li key={i} className={`flex items-center gap-2 py-1.5 pr-1.5 pl-3.5 ${pending ? 'flex-wrap justify-end' : ''}`}>
              <Link to={actionLink(a)} className={`flex min-w-0 items-center gap-2.5 py-1 ${pending ? 'basis-full' : 'flex-1'} ${a.state === 'undone' ? 'opacity-50' : ''}`}>
                <KindIcon a={a} tone={pending ? 'danger' : a.state === 'undone' ? 'muted' : 'accent'} />
                <span className="min-w-0">
                  <span className={`block text-sm font-medium ${pending ? 'break-words' : 'truncate'} ${a.state === 'undone' ? 'line-through' : ''}`}>{a.title}</span>
                  <span className={`block truncate text-xs ${pending ? 'text-danger' : 'text-lh-text-secondary'}`}>
                    {pending ? t(CONFIRM_LABELS[a.kind] ?? 'Удалить?') : actionLabel(a)}
                  </span>
                </span>
              </Link>
              <RowControls a={a} i={i} {...h} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
