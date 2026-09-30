import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { StatCard } from '../../components/ui/StatCard';
import { todayKey, WEEKDAY_LABELS } from '../../lib/dates';
import { isActiveOn, isLogDone } from '../../lib/habits';
import {
  byWeekday,
  dailyPoints,
  hasEnoughMarks,
  levelByDate,
  splitByLevel,
  weekTrend,
  windowDates,
  type Average,
} from '../../lib/energy';
import { useNavLayout } from '../../hooks/useNavLayout';
import type { EnergyLevel } from '../../db/types';
import { getLang, t } from '../../lib/i18n';

/** Окно, по которому считаются спарклайн, дни недели и связки. */
const WINDOW_DAYS = 28;

/** Высота зоны столбика в блоке дней недели, px. */
const BAR_ZONE = 48;

function fmt(avg: number | null, digits = 1): string {
  return avg === null ? '—' : avg.toFixed(digits);
}

function pct(share: number | null): string {
  return share === null ? '—' : `${Math.round(share * 100)}%`;
}

/** Столбик уровня: высота от 1 до 5, пропуск — еле заметная риска у основания.
 *  Пропуск НЕ рисуется нулём: иначе месяц с двумя отметками выглядит как месяц
 *  беспросветного дна, хотя данных просто нет. */
function LevelBar({ level, width }: { level: EnergyLevel | null; width: string }) {
  return (
    <div className="flex items-end" style={{ width, height: '100%' }}>
      <div
        className="w-full rounded-t-sm bg-lh-accent"
        style={{
          height: level === null ? 2 : `${(level / 5) * 100}%`,
          opacity: level === null ? 0.18 : 0.35 + (level / 5) * 0.65,
        }}
      />
    </div>
  );
}

/** Строка связки: «в дни 1–2 … против … в дни 4–5». Показывается только когда
 *  обе группы непустые — сравнивать с пустотой нечестно. */
function LinkRow({
  label,
  low,
  high,
  format,
}: {
  label: string;
  low: Average;
  high: Average;
  format: (avg: number | null) => string;
}) {
  if (low.n === 0 || high.n === 0) return null;
  return (
    <div className="flex items-baseline justify-between gap-2 py-1.5">
      <span className="min-w-0 flex-1 text-xs text-lh-text-secondary">{label}</span>
      <span className="shrink-0 text-xs">
        <span className="font-semibold">{format(low.avg)}</span>
        <span className="text-lh-text-secondary"> {t('({n} дн.)', { n: low.n })}</span>
        <span className="text-lh-text-secondary"> → </span>
        <span className="font-semibold">{format(high.avg)}</span>
        <span className="text-lh-text-secondary"> {t('({n} дн.)', { n: high.n })}</span>
      </span>
    </div>
  );
}

/**
 * Блок энергии в статистике. Молчит, пока отметок меньше семи: на пяти точках
 * «тренд» — это шум, который выглядит как знание. Никаких советов и оценок —
 * только числа и сколько дней за ними стоит.
 */
export function EnergyStatsCard() {
  const { hidden } = useNavLayout();
  const today = todayKey();
  const logs = useLiveQuery(() => db.energyLogs.toArray(), []);
  const habitsRaw = useLiveQuery(() => db.habits.toArray(), []);
  const habitLogsRaw = useLiveQuery(() => db.habitLogs.toArray(), []);
  const tasksRaw = useLiveQuery(() => db.tasks.toArray(), []);

  const byDate = levelByDate(alive(logs ?? []));

  // После хуков: скрытый раздел молчит и здесь — выключив «Энергию», человек
  // не должен натыкаться на её аналитику в статистике.
  if (hidden.includes('energy')) return null;
  if (!hasEnoughMarks(byDate)) return null;

  const trend = weekTrend(byDate, today);
  const points = dailyPoints(byDate, today, WINDOW_DAYS);
  const weekdays = byWeekday(byDate, today, WINDOW_DAYS);
  const window = windowDates(today, WINDOW_DAYS);

  // Привычки: доля выполненных из запланированных на день. Дни без плана
  // (расписание, заморозка) в связку не идут — делить было бы не на что.
  const habits = alive(habitsRaw ?? []).filter((h) => !h.archivedAt);
  const habitLogs = alive(habitLogsRaw ?? []);
  const habitShare = new Map<string, number>();
  if (habits.length > 0) {
    const doneByDate = new Map<string, Set<string>>();
    for (const l of habitLogs) {
      const habit = habits.find((h) => h.id === l.habitId);
      if (!habit || !isLogDone(habit, l.value)) continue;
      const set = doneByDate.get(l.date);
      if (set) set.add(l.habitId);
      else doneByDate.set(l.date, new Set([l.habitId]));
    }
    for (const date of window) {
      const planned = habits.filter((h) => isActiveOn(h, date));
      if (planned.length === 0) continue;
      const done = doneByDate.get(date);
      const doneCount = done ? planned.filter((h) => done.has(h.id)).length : 0;
      habitShare.set(date, doneCount / planned.length);
    }
  }

  // Задачи: сколько закрыто в этот день. Знаменателя у задач нет (список
  // растёт и тает в течение дня), поэтому здесь честнее считать штуки.
  const tasks = alive(tasksRaw ?? []);
  const closedPerDay = new Map<string, number>();
  for (const date of window) closedPerDay.set(date, 0);
  for (const t of tasks) {
    if (!t.completedAt) continue;
    const date = t.completedAt.slice(0, 10);
    const prev = closedPerDay.get(date);
    if (prev !== undefined) closedPerDay.set(date, prev + 1);
  }

  const habitSplit = splitByLevel(byDate, habitShare);
  const taskSplit = splitByLevel(byDate, closedPerDay);

  const deltaText =
    trend.delta === null
      ? null
      : trend.delta === 0
        ? t('без изменений')
        : t('{delta} к прошлой неделе', { delta: `${trend.delta > 0 ? '+' : '−'}${Math.abs(trend.delta).toFixed(1)}` });

  const maxWeekday = Math.max(...weekdays.map((w) => w.avg ?? 0), 1);

  return (
    <StatCard title={t('Энергия')}>
      <div className="mb-4 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-light leading-tight">
            {fmt(trend.current.avg)}
            <span className="text-sm font-normal text-lh-text-secondary">{t(' из 5')}</span>
          </p>
          <p className="text-xs text-lh-text-secondary">
            {t('в среднем за 7 дней · отмечено {n} из 7', { n: trend.current.n })}
          </p>
        </div>
        <p className="shrink-0 text-xs text-lh-text-secondary">
          {deltaText ?? t('не с чем сравнить')}
        </p>
      </div>

      {/* 28 дней: пропуски видно как пустоты — это тоже информация. */}
      <div className="mb-1 flex items-end gap-px" style={{ height: 56 }}>
        {points.map((p) => (
          <LevelBar key={p.date} level={p.level} width={`${100 / WINDOW_DAYS}%`} />
        ))}
      </div>
      <p className="mb-4 text-2xs text-lh-text-secondary">
        {t('4 недели · отмечено {n} дн.', { n: byDate.size })}
      </p>

      <div className="mb-4">
        {/* «По дням недели» — омоним ключа из расписания привычек (Specific days),
            здесь смысл другой — явная ветка языка. */}
        <p className="mb-2 text-xs font-medium text-lh-text-secondary">{getLang() === 'en' ? 'By weekday' : 'По дням недели'}</p>
        <div className="flex items-end justify-between gap-2">
          {weekdays.map((w) => (
            <div key={w.weekday} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className="text-2xs font-semibold text-lh-text-secondary">
                {w.avg === null ? '' : fmt(w.avg)}
              </span>
              {/* Высота зоны столбика — в пикселях, а не flex-1: проценты внутри
                  flex-контейнера без явной высоты считаются от auto и столбики
                  схлопываются в ноль (проверено на живом экране). */}
              <div className="flex w-full items-end" style={{ height: BAR_ZONE }}>
                <div
                  data-testid="weekday-bar"
                  className="w-full rounded-t-md bg-lh-accent transition-[height] duration-300"
                  style={{
                    height: w.avg === null ? 2 : Math.round((w.avg / maxWeekday) * BAR_ZONE),
                    opacity: w.avg === null ? 0.2 : 1,
                  }}
                />
              </div>
              <span className="text-2xs text-lh-text-secondary">{WEEKDAY_LABELS[w.weekday - 1]}</span>
            </div>
          ))}
        </div>
      </div>

      {(habitSplit.low.n > 0 && habitSplit.high.n > 0) ||
      (taskSplit.low.n > 0 && taskSplit.high.n > 0) ? (
        <div className="border-t border-lh-border pt-2">
          <p className="mb-1 text-xs font-medium text-lh-text-secondary">{t('В дни 1–2 против дней 4–5')}</p>
          <LinkRow
            label={t('Привычек выполнено')}
            low={habitSplit.low}
            high={habitSplit.high}
            format={pct}
          />
          <LinkRow
            label={t('Задач закрыто за день')}
            low={taskSplit.low}
            high={taskSplit.high}
            format={(v) => fmt(v)}
          />
        </div>
      ) : null}
    </StatCard>
  );
}
