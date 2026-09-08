import { useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import {
  CircleX,
  CornerDownLeft,
} from 'lucide-react';
import { isTouch } from '../../lib/platform';
import { db } from '../../db/db';
import { create } from '../../db/repo';
import { Input } from '../../components/ui/Input';
import { MicButton } from '../../components/ui/MicButton';
import { HIT_SLOP_44 } from '../../components/ui/Checkbox';
import { Hint } from '../../components/ui/Hint';
import { dismissHintOnUse } from '../../hooks/useHint';
import { describeParsed, parseQuickTask } from '../../lib/nlDate';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import {
  GSparkle as Sparkles,
  GSend as Send,
} from '../../components/ui/glyphs';

/** Подсказка живёт под этим ключом и в разметке, и в скрытии по факту
 *  использования — поэтому одна константа, а не два одинаковых литерала. */
const QUICK_ADD_HINT = 'tasks-quick-add';

/**
 * Быстрый ввод задачи в стиле TickTick: одна строка без открытия формы.
 * Текст разбирается parseQuickTask — естественная дата/время уходят в поля,
 * остальное остаётся заголовком. Полная форма (Fab/тап) не затрагивается.
 */
export function QuickAddBar({
  defaultDueDate,
  defaultProjectId,
}: {
  defaultDueDate?: string | null;
  defaultProjectId?: string | null;
}) {
  const [text, setText] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const parsed = useMemo(() => (text.trim() ? parseQuickTask(text) : null), [text]);
  const hint = parsed ? describeParsed(parsed) : null;

  async function submit() {
    const raw = text.trim();
    if (!raw) return;
    const p = parseQuickTask(raw);
    await create(db.tasks, {
      title: p.title,
      notes: '',
      projectId: defaultProjectId ?? null,
      goalId: null,
      priority: p.priority,
      dueDate: p.dueDate ?? defaultDueDate ?? null,
      startDate: p.startDate,
      dueTime: p.dueTime,
      duration: null,
      remindBefore: null,
      completedAt: null,
      checklist: [],
      recurrence: null,
      tags: p.tags,
      sortOrder: Date.now(),
    });
    setText('');
    // Задача добавлена этой строкой — значит подсказка про неё свою работу
    // сделала и больше не занимает 165px над списком.
    void dismissHintOnUse(QUICK_ADD_HINT);
    wrapRef.current?.querySelector('input')?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  }

  const canSend = text.trim().length > 0;

  return (
    <div className="mb-4">
      <div ref={wrapRef} className="card px-3 py-2">
        {/* gap-3 (12.75px), а не gap-2: микрофон и «отправить» — по 37px,
            их зоны 44x44 вылезают на 3.5px в каждую сторону, поэтому при зазоре
            4.25px зоны перекрывались на 2.75px. Верх по DOM — «отправить», и
            промах мимо микрофона вправо создавал задачу вместо диктовки. При
            8.5px между зонами остаётся 1.5px чистого зазора. Поле ужимается на
            8.5px (на 320px остаётся 167.5px) — это только обрезка плейсхолдера,
            min-w-0 у обёртки Input не даёт строке уехать за карточку. */}
        <div className="flex items-center gap-3">
          <Input
            value={text}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onClear={() => setText('')}
            placeholder={t('Что нужно сделать?')}
            className="border-0 bg-transparent px-1 py-2 focus:ring-0"
          />
          <MicButton
            onText={(spoken) => setText((cur) => (cur ? `${cur} ${spoken}` : spoken))}
            className={HIT_SLOP_44}
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            aria-label={t('Добавить задачу')}
            className={`shrink-0 rounded-full p-2 transition-transform active:scale-90 ${HIT_SLOP_44} ${
              canSend ? 'text-accent' : 'text-muted opacity-40'
            }`}
          >
            <Send size={ICON.header} />
          </button>
        </div>
        {hint && <p className="px-1 pt-0.5 pb-1 text-xs text-accent">{hint}</p>}
      </div>
      <Hint
        id={QUICK_ADD_HINT}
        title={t('Быстрое добавление')}
        className="mt-2"
        items={[
          { icon: Sparkles, text: <>{t('Пишите естественно: «завтра в 10 позвонить маме» — дата и время подставятся сами')}</> },
          isTouch
            ? { icon: Send, text: <>{t('Стрелка справа — добавить задачу')}</> }
            : { icon: CornerDownLeft, text: <>{t('Enter — добавить задачу')}</> },
          { icon: CircleX, text: <>{t('Крестик слева стирает всё написанное')}</> },
        ]}
      />
    </div>
  );
}
