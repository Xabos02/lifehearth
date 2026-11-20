import type { MouseEvent } from 'react';
import { GFaMinus, GFaPlus } from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { create, now, update } from '../../db/repo';
import type { LearningItem } from '../../db/types';
import { todayKey } from '../../lib/dates';
import { formatNum } from '../../lib/finance';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import { Haptic } from '../../components/ui/Haptic';

const BTN_CLASS =
  'flex size-12 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 text-lh-text-primary active:opacity-70 disabled:opacity-40';

// Имя на *_LABELS — чтобы таблицу видел сторож перевода (i18nCoverage.test).
const UNIT_LABELS: Record<LearningItem['progressUnit'], string> = {
  pages: 'страница из {n}',
  lessons: 'урок из {n}',
  hours: 'ч из {n}',
  percent: 'из 100%',
};

/** Счётчик прогресса на экране материала: крупное число, − и + по бокам,
 *  полоса и для страниц — «+10». Каждое изменение пишется в историю.
 *
 *  Кнопки — только у материала «В процессе», как было в списке: у книги
 *  «В планах» шаг не начинал её, у завершённой «−» оставлял «Завершено» при
 *  299 из 300, а «+» обратно переписывал дату завершения. */
export function ProgressStepper({ item }: { item: LearningItem }) {
  const editable = item.status === 'inProgress';
  const step = item.progressUnit === 'percent' ? 5 : 1;
  const pct = item.progressTarget > 0 ? Math.min(100, (100 * item.progressCurrent) / item.progressTarget) : 0;

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
    <div className="card p-4" onClick={(e: MouseEvent<HTMLDivElement>) => e.stopPropagation()}>
      <div className={`flex items-center gap-3 ${editable ? 'justify-between' : 'justify-center'}`}>
        {editable && (
          <button
            type="button"
            className={BTN_CLASS}
            aria-label={t('Уменьшить прогресс')}
            disabled={item.progressCurrent <= 0}
            onClick={() => void setValue(item.progressCurrent - step)}
          >
            <GFaMinus size={ICON.inline} />
            {/* Шаг прогресса щёлкает под пальцем (PROTOCOL §6.4); у упора кнопка
                выключена и накладки нет. */}
            {item.progressCurrent > 0 && <Haptic />}
          </button>
        )}
        <div className="min-w-0 text-center">
          <p className="text-3xl font-light leading-none tabular-nums">
            {formatNum(item.progressCurrent)}
            {item.progressUnit === 'percent' ? '%' : ''}
          </p>
          <p className="mt-1 text-xs tabular-nums text-lh-text-secondary">
            {t(UNIT_LABELS[item.progressUnit], { n: formatNum(item.progressTarget) })}
          </p>
        </div>
        {editable && (
          <button
            type="button"
            className={BTN_CLASS}
            aria-label={t('Увеличить прогресс')}
            disabled={item.progressCurrent >= item.progressTarget}
            onClick={() => void setValue(item.progressCurrent + step)}
          >
            <GFaPlus size={ICON.inline} />
            {item.progressCurrent < item.progressTarget && <Haptic />}
          </button>
        )}
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-lh-surface-2" aria-hidden>
        <div className="h-full rounded-full bg-lh-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      {editable && item.progressUnit === 'pages' && (
        <button
          type="button"
          className="mt-3 h-11 w-full rounded-xl border border-lh-border text-sm text-lh-accent active:opacity-70 disabled:opacity-40"
          disabled={item.progressCurrent >= item.progressTarget}
          onClick={() => void setValue(item.progressCurrent + 10)}
        >
          {t('Плюс десять страниц')}
          {item.progressCurrent < item.progressTarget && <Haptic />}
        </button>
      )}
    </div>
  );
}
