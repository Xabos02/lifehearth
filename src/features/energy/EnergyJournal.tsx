import { useState } from 'react';
import { formatRu, todayKey } from '../../lib/dates';
import { ENERGY_LABEL, windowDates } from '../../lib/energy';
import { EnergyLevelSheet } from './EnergyLevelSheet';
import type { EnergyLevel } from '../../db/types';
import { t } from '../../lib/i18n';

/** Сколько дней показывает дневник. Две недели — столько, сколько человек
 *  реально помнит про свои силы; дальше отметка задним числом уже выдумка. */
const JOURNAL_DAYS = 14;

interface Props {
  byDate: Map<string, EnergyLevel>;
}

/** Последние две недели сеткой 7×2: пропуски видно сразу, любой день
 *  дозаполняется тапом. Список строками занимал бы три экрана и утаскивал
 *  каталог способов под сгиб — поэтому сетка, а не список. */
export function EnergyJournal({ byDate }: Props) {
  const today = todayKey();
  const [editing, setEditing] = useState<string | null>(null);
  const days = windowDates(today, JOURNAL_DAYS);
  const marked = days.filter((d) => byDate.has(d)).length;

  return (
    <section>
      <h2 className="mb-2 flex items-center justify-between px-1 lh-section">
        <span>{t('Последние две недели')}</span>
        <span className="text-xs font-normal">
          {t('{done} из {total}', { done: marked, total: JOURNAL_DAYS })}
        </span>
      </h2>
      <div className="card grid grid-cols-7 gap-1 p-3">
        {days.map((date) => {
          const level = byDate.get(date) ?? null;
          const isToday = date === today;
          return (
            <button
              key={date}
              type="button"
              aria-label={`${formatRu(date)} — ${level ? t(ENERGY_LABEL[level]) : t('нет отметки')}`}
              onClick={() => setEditing(date)}
              className="flex min-h-11 min-w-11 flex-1 flex-col items-center gap-1 py-1 active:opacity-70"
            >
              <span
                aria-hidden
                className={`flex size-8 items-center justify-center rounded-full text-sm font-semibold ${
                  level
                    ? 'bg-lh-accent text-lh-bg'
                    : 'border border-dashed border-lh-border'
                } ${isToday ? 'ring-2 ring-lh-accent ring-offset-2 ring-offset-lh-surface' : ''}`}
              >
                {level ?? ''}
              </span>
              <span className="text-2xs text-lh-text-secondary">{formatRu(date, 'd')}</span>
            </button>
          );
        })}
      </div>
      <EnergyLevelSheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        date={editing}
        current={editing ? (byDate.get(editing) ?? null) : null}
      />
    </section>
  );
}
