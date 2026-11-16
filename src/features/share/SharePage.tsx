import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ClipboardPaste,
  NotebookPen,
} from 'lucide-react';
import { Screen } from '../../components/layout/Screen';
import { AutoGrowTextarea } from '../../components/ui/Input';
import { useToast } from '../../components/ui/toastContext';
import { db } from '../../db/db';
import { create } from '../../db/repo';
import { newSortOrder } from '../tasks/taskActions';
import { parseQuickTask } from '../../lib/nlDate';
// Тот же разбор, что у вставки в редакторе заметок: своя копия здесь не знала
// про переносы Windows (\r\n), табуляцию между колонками и отступы — текст,
// пойманный на iPhone «Вставить из буфера», приезжал слипшимся.
import { plainTextToNoteHtml } from '../notes/pasteHtml';
import { t, tPlur } from '../../lib/i18n';
import { formatDueDate, toKey } from '../../lib/dates';
import { ICON } from '../../components/ui/icons';
import {
  GTasks as ListTodo,
} from '../../components/ui/glyphs';

function firstLine(text: string): string {
  return (text.split('\n').map((s) => s.trim()).find(Boolean) ?? '').slice(0, 300);
}

/**
 * Экран быстрого захвата. Три входа в одну точку:
 *  — Android/десктоп: системное «Поделиться» → share_target (GET) с текстом;
 *  — iPhone: ярлык iOS Shortcuts открывает этот же /share?text=…;
 *  — вручную: кнопка «Вставить из буфера» (главный путь на iOS, где системного
 *    приёма «поделиться» в PWA нет).
 * Из захваченного текста в один тап делается задача (с разбором даты/времени)
 * или заметка.
 */
export function SharePage() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const initial = Array.from(
    new Set([sp.get('title'), sp.get('text'), sp.get('url')].filter(Boolean) as string[]),
  ).join('\n');
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const canCreate = value.trim().length > 0;
  const lineCount = value.split('\n').filter((l) => l.trim()).length;

  // Последние три записи — задачи и заметки вместе, по времени создания.
  // Отдельного признака «пришло через захват» у записей нет, поэтому честно
  // «Недавно добавлено», а не «сохранено отсюда».
  const recent = useLiveQuery(async () => {
    const [tasks, notes] = await Promise.all([
      db.tasks.filter((x) => !x.deletedAt).toArray(),
      db.notes.filter((x) => !x.deletedAt).toArray(),
    ]);
    return [
      ...tasks.map((x) => ({ id: x.id, kind: 'task' as const, title: x.title, createdAt: x.createdAt, to: '/tasks' })),
      ...notes.map((x) => ({ id: x.id, kind: 'note' as const, title: x.title, createdAt: x.createdAt, to: `/notes/${x.id}` })),
    ]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 3);
  }, []) ?? [];

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        toast(t('Буфер обмена пуст'));
        return;
      }
      setValue((cur) => (cur.trim() ? `${cur}\n${text}` : text));
    } catch {
      toast(t('Не удалось прочитать буфер обмена. Вставьте текст вручную'));
    }
  }

  async function createTask() {
    const raw = value.trim();
    if (!raw || busy) return;
    setBusy(true);
    try {
      const p = parseQuickTask(raw);
      await create(db.tasks, {
        title: p.title,
        notes: '',
        projectId: null,
        goalId: null,
        priority: p.priority,
        dueDate: p.dueDate,
        dueTime: p.dueTime,
        duration: null,
        remindBefore: null,
        completedAt: null,
        checklist: [],
        recurrence: null,
        tags: p.tags,
        sortOrder: newSortOrder(p.priority),
      });
      toast(t('Задача создана'));
      navigate('/tasks');
    } finally {
      setBusy(false);
    }
  }

  async function createNote() {
    const raw = value.trim();
    if (!raw || busy) return;
    setBusy(true);
    try {
      const note = await create(db.notes, {
        title: firstLine(raw),
        content: plainTextToNoteHtml(raw),
        tags: [],
        pinned: false,
      });
      toast(t('Заметка создана'));
      navigate(`/notes/${note.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title={t('Захват')}
      right={
        <button
          type="button"
          onClick={() => navigate('/')}
          className="flex h-11 items-center px-3 text-base text-lh-accent active:opacity-60"
        >
          {t('Закрыть')}
        </button>
      }
    >
      <div className="flex flex-col gap-6">
        <p className="-mt-2 text-sm text-lh-text-secondary">
          {t('Быстро сохраните мысль, ссылку или текст из другого приложения — разложите по полкам потом.')}
        </p>

        <section className="card p-4 transition-[border-color,box-shadow] focus-within:border-lh-accent-border focus-within:ring-2 focus-within:ring-lh-accent-dim">
          <AutoGrowTextarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('Что сохранить?')}
            aria-label={t('Что сохранить?')}
            className="min-h-[9rem] !border-0 !bg-transparent !p-0 text-base leading-relaxed focus:!ring-0"
            autoFocus={!initial}
          />
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-lh-border pt-3">
            <button
              type="button"
              onClick={() => void pasteFromClipboard()}
              className="flex h-11 items-center gap-2 px-1 text-sm text-lh-accent active:opacity-60"
            >
              <ClipboardPaste size={ICON.inline} />
              {t('Вставить из буфера')}
            </button>
            {lineCount > 0 && (
              <span className="shrink-0 text-2xs tabular-nums text-lh-text-secondary">
                {tPlur(lineCount, ['строка', 'строки', 'строк'])}
              </span>
            )}
          </div>
        </section>

        <div className="flex flex-col gap-2">
          <section className="grid grid-cols-2 gap-3">
            <button
              type="button"
              disabled={!canCreate || busy}
              onClick={() => void createTask()}
              className="flex h-[104px] flex-col items-center justify-center gap-2.5 rounded-[16px] bg-lh-accent text-lh-bg active:opacity-80 disabled:opacity-40"
            >
              <ListTodo size={ICON.accent} />
              <span className="text-base font-semibold">{t('В задачи')}</span>
            </button>
            <button
              type="button"
              disabled={!canCreate || busy}
              onClick={() => void createNote()}
              className="card flex h-[104px] flex-col items-center justify-center gap-2.5 text-lh-text-primary active:opacity-80 disabled:opacity-40"
            >
              <NotebookPen size={ICON.accent} className="text-lh-accent" />
              <span className="text-base font-semibold">{t('В заметки')}</span>
            </button>
          </section>
          <p className="px-6 text-center text-xs text-lh-text-secondary">
            {t('Дата и время из текста подставятся в задачу сами — например «завтра в 10 позвонить маме».')}
          </p>
        </div>

        {recent.length > 0 && (
          <section aria-labelledby="share-recent">
            <h2 id="share-recent" className="mb-2.5 px-1 lh-section">
              {t('Недавно добавлено')}
            </h2>
            <ul className="card divide-y divide-lh-border overflow-hidden">
              {recent.map((r) => {
                const Icon = r.kind === 'task' ? ListTodo : NotebookPen;
                return (
                  <li key={r.id}>
                    <Link
                      to={r.to}
                      className="flex min-h-11 items-center gap-3 px-4 py-3 active:bg-lh-surface-2"
                    >
                      <Icon size={ICON.base} className="shrink-0 text-lh-text-secondary" />
                      <span className="min-w-0 flex-1 truncate text-sm">{r.title || t('Без названия')}</span>
                      <span className="shrink-0 text-2xs tabular-nums text-lh-text-secondary">
                        {formatDueDate(toKey(new Date(r.createdAt)))}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </Screen>
  );
}
