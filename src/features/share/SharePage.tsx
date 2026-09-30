import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  ClipboardPaste,
  NotebookPen,
} from 'lucide-react';
import { Screen } from '../../components/layout/Screen';
import { Button } from '../../components/ui/Button';
import { AutoGrowTextarea } from '../../components/ui/Input';
import { useToast } from '../../components/ui/toastContext';
import { db } from '../../db/db';
import { create } from '../../db/repo';
import { parseQuickTask } from '../../lib/nlDate';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import {
  GTasks as ListTodo,
} from '../../components/ui/glyphs';

/** Экранирование текста перед вставкой в HTML-заметку. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Текст → HTML заметки: первая строка «голым» текстом (заголовок), тело — <div>. */
function textToNoteHtml(text: string): string {
  const [first, ...rest] = text.split('\n');
  return esc(first ?? '') + rest.map((l) => `<div>${esc(l) || '<br>'}</div>`).join('');
}

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
        sortOrder: Date.now(),
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
        content: textToNoteHtml(raw),
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
    <Screen title={t('Захват')} backTo="/">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-lh-text-secondary">
          {t(
            'Вставьте или отредактируйте текст и сохраните его задачей или заметкой. Для задачи дата и время из текста подставятся сами — например «завтра в 10 позвонить маме».',
          )}
        </p>

        <AutoGrowTextarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('Что сохранить?')}
          className="min-h-[7rem]"
          autoFocus={!initial}
        />

        <Button variant="secondary" onClick={() => void pasteFromClipboard()}>
          <ClipboardPaste size={ICON.base} className="mr-2 inline" />
          {t('Вставить из буфера')}
        </Button>

        <div className="mt-1 flex gap-2">
          <Button className="flex-1" disabled={!canCreate || busy} onClick={() => void createTask()}>
            <ListTodo size={ICON.base} className="mr-2 inline" />
            {t('В задачи')}
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            disabled={!canCreate || busy}
            onClick={() => void createNote()}
          >
            <NotebookPen size={ICON.base} className="mr-2 inline" />
            {t('В заметки')}
          </Button>
        </div>
      </div>
    </Screen>
  );
}
