import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { ICON } from '../../components/ui/icons';
import type { EnergyLevel } from '../../db/types';
import { addDaysKey, todayKey } from '../../lib/dates';
import { hasEnoughMarks, weekTrend, windowDates, type Average } from '../../lib/energy';
import { getLang, t } from '../../lib/i18n';
import { useEnergySplits } from './useEnergySplits';

const WINDOW_DAYS = 28;

/** Одна цифра после запятой по языку: «3,6» / «3.6» (PROTOCOL §7.7). */
function one(v: number | null): string {
  return v === null
    ? '—'
    : v.toLocaleString(getLang() === 'ru' ? 'ru-RU' : 'en-US', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
}

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

function weekAvg(byDate: Map<string, EnergyLevel>, end: string): number | null {
  const levels = windowDates(end, 7)
    .map((d) => byDate.get(d))
    .filter((l): l is EnergyLevel => l !== undefined);
  return levels.length === 0 ? null : levels.reduce((s, l) => s + l, 0) / levels.length;
}

function Compare({
  label,
  low,
  high,
  format,
}: {
  label: string;
  low: Average;
  high: Average;
  format: (v: number | null) => string;
}) {
  if (low.n === 0 || high.n === 0) return null;
  // n рядом с каждым числом (lib/energy.ts): 100% по одному дню и по двадцати —
  // разные утверждения. Подпись переносится по слогам, числа — никогда.
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 hyphens-auto">{label}</span>
      <span className="whitespace-nowrap tabular-nums text-lh-text-secondary">
        {format(low.avg)} <span className="text-xs">{t('({n} дн.)', { n: low.n })}</span>
      </span>
      <ArrowRight size={ICON.inline} className="shrink-0 text-lh-text-secondary" aria-hidden />
      <span className="whitespace-nowrap tabular-nums">
        <span className="font-semibold text-lh-accent">{format(high.avg)}</span>{' '}
        <span className="text-xs text-lh-text-secondary">{t('({n} дн.)', { n: high.n })}</span>
      </span>
    </div>
  );
}

/** Сводка сил: средняя за неделю, тренд, четыре недели и связка с делами. */
export function EnergySummary({ byDate }: { byDate: Map<string, EnergyLevel> }) {
  const today = todayKey();
  const { habitSplit, taskSplit } = useEnergySplits(byDate, today, WINDOW_DAYS);
  const trend = weekTrend(byDate, today);
  const weeks = [3, 2, 1, 0].map((i) => weekAvg(byDate, addDaysKey(today, -7 * i)));
  // Средняя за 7 дней видна всегда — при ней стоит «отмечено n из 7». Тренд,
  // четыре недели и связка ждут ENOUGH_MARKS, как блок в статистике: на паре
  // точек это шум, который выглядит как знание.
  const enough = hasEnoughMarks(byDate);
  const hasLinks =
    (habitSplit.low.n > 0 && habitSplit.high.n > 0) || (taskSplit.low.n > 0 && taskSplit.high.n > 0);
  const delta = enough ? trend.delta : null;
  const DeltaIcon = delta !== null && delta < 0 ? ArrowDown : ArrowUp;

  return (
    <section className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-5xl font-light leading-none tabular-nums">
            {one(trend.current.avg)}
            <span className="ml-1 text-lg text-lh-text-secondary">{t('из 5')}</span>
          </p>
          <p className="mt-2 text-xs tabular-nums text-lh-text-secondary">
            {t('в среднем за 7 дней · отмечено {n} из 7', { n: trend.current.n })}
          </p>
          {delta !== null && (
            <p
              className={`mt-1 flex items-center gap-1 text-xs tabular-nums ${
                delta > 0 ? 'text-success' : 'text-lh-text-secondary'
              }`}
            >
              {delta !== 0 && <DeltaIcon size={ICON.inline} className="shrink-0" aria-hidden />}
              {delta === 0
                ? t('без изменений')
                : t('{delta} к прошлой неделе', {
                    delta: `${delta > 0 ? '+' : '−'}${one(Math.abs(delta))}`,
                  })}
            </p>
          )}
        </div>
        {enough && (
          <div
            className="shrink-0 text-right"
            role="img"
            aria-label={t('4 недели, от ранней к текущей: {list}', {
              list: weeks.map((avg) => (avg === null ? t('нет отметок') : one(avg))).join('; '),
            })}
          >
            <div className="flex h-12 items-end gap-1.5">
              {/* Прошлые недели — данные, а не фон: secondary держит ≥3:1 к
                  карточке (тёмная 5.12, светлая 5.53; surface-2 давал 1.12),
                  текущая отличается от них цветом. */}
              {weeks.map((avg, i) => (
                <span
                  key={i}
                  className={`w-3 rounded-sm ${i === weeks.length - 1 ? 'bg-lh-accent' : 'bg-lh-text-secondary'}`}
                  style={{ height: avg === null ? 3 : `${(avg / 5) * 100}%` }}
                />
              ))}
            </div>
            <p className="mt-1 text-2xs text-lh-text-secondary">{t('4 недели')}</p>
          </div>
        )}
      </div>
      {enough && hasLinks && (
        <div className="mt-5 border-t border-lh-border pt-4">
          <p className="mb-3 text-xs text-lh-text-secondary">{t('В дни 1–2 против дней 4–5')}</p>
          <div className="space-y-2.5">
            <Compare label={t('Привычек выполнено')} low={habitSplit.low} high={habitSplit.high} format={pct} />
            <Compare label={t('Задач закрыто за день')} low={taskSplit.low} high={taskSplit.high} format={one} />
          </div>
        </div>
      )}
    </section>
  );
}
