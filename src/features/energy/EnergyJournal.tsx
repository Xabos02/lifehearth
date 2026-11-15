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
      <div className="mb-1 flex items-center justify-between gap-2 px-1">
        <h2 className="lh-section">{t('Последние две недели')}</h2>
        <button
          type="button"
          onClick={() => setEditing(today)}
          className="-mr-1 flex h-11 items-center px-1 text-sm text-lh-accent active:opacity-60"
        >
          {t('Отметить сегодня')}
        </button>
      </div>
      <div className="card p-3">
        <div className="grid grid-cols-7 gap-1">
          {days.map((date, i) => {
            const level = byDate.get(date) ?? null;
            const isToday = date === today;
            return (
              <button
                key={date}
                type="button"
                aria-label={`${formatRu(date)} — ${level ? t(ENERGY_LABEL[level]) : t('нет отметки')}`}
                onClick={() => setEditing(date)}
                className="flex min-h-11 min-w-11 flex-col items-center gap-1 px-1 pt-1 active:opacity-70"
              >
                <span aria-hidden className="flex h-10 w-full items-end">
                  <span
                    className={`w-full rounded ${
                      level ? `bg-lh-accent ${i < 7 ? 'opacity-60' : ''}` : 'bg-lh-surface-2'
                    } ${isToday ? 'ring-1 ring-lh-accent' : ''}`}
                    style={{ height: level ? `${(level / 5) * 100}%` : 4 }}
                  />
                </span>
                <span
                  className={`text-2xs tabular-nums ${
                    isToday ? 'font-semibold text-lh-accent' : 'text-lh-text-secondary'
                  }`}
                >
                  {formatRu(date, 'd')}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 px-1 text-2xs text-lh-text-secondary">
          {t('{done} из {total}', { done: marked, total: JOURNAL_DAYS })}
        </p>
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
