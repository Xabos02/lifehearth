import type { MouseEvent } from 'react';
import { Minus } from 'lucide-react';
import {
  GPlus as Plus,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { create, now, update } from '../../db/repo';
import type { LearningItem } from '../../db/types';
import { todayKey } from '../../lib/dates';
import { formatNum } from '../../lib/finance';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';

const BTN_CLASS =
  `flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-text active:opacity-70 disabled:opacity-40 ${HIT_SLOP_44}`;

/** Компактный степпер прогресса: −, значение, +, для страниц ещё «+10». */
export function ProgressStepper({ item }: { item: LearningItem }) {
  const step = item.progressUnit === 'percent' ? 5 : 1;

  const setValue = async (next: number) => {
    const value = Math.max(0, Math.min(item.progressTarget, next));
    if (value === item.progressCurrent) return;
    await update(db.learningItems, item.id, { progressCurrent: value });
    // Лог на каждый клик — это ок, это история прогресса.
    await create(db.learningLogs, { itemId: item.id, date: todayKey(), value });
    if (value >= item.progressTarget && item.progressTarget > 0) {
      await update(db.learningItems, item.id, { status: 'done', finishedAt: now() });
    }
  };

  return (
    <div
      className="flex items-center gap-2"
      onClick={(e: MouseEvent<HTMLDivElement>) => e.stopPropagation()}
    >
      <button
        className={BTN_CLASS}
        aria-label={t('Уменьшить прогресс')}
        disabled={item.progressCurrent <= 0}
        onClick={() => void setValue(item.progressCurrent - step)}
      >
        <Minus size={ICON.base} />
      </button>
      <span className="min-w-12 text-center font-bold tabular-nums">
        {formatNum(item.progressCurrent)}
        {item.progressUnit === 'percent' ? '%' : ''}
      </span>
      <button
        className={BTN_CLASS}
        aria-label={t('Увеличить прогресс')}
        disabled={item.progressCurrent >= item.progressTarget}
        onClick={() => void setValue(item.progressCurrent + step)}
      >
        <Plus size={ICON.base} />
      </button>
      {item.progressUnit === 'pages' && (
        <button
          className={`${BTN_CLASS} w-auto px-3 text-sm font-semibold`}
          aria-label={t('Плюс десять страниц')}
          disabled={item.progressCurrent >= item.progressTarget}
          onClick={() => void setValue(item.progressCurrent + 10)}
        >
          +10
        </button>
      )}
    </div>
  );
}
