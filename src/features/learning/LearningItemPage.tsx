import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { differenceInCalendarDays } from 'date-fns';
import { Clock, Pencil, Plus } from 'lucide-react';
import { Screen } from '../../components/layout/Screen';
import { Button } from '../../components/ui/Button';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { LearningItem, LearningLog, LearningPart } from '../../db/types';
import { addDaysKey, formatRu, fromKey, todayKey, toKey, WEEKDAY_LABELS } from '../../lib/dates';
import { formatDuration } from '../../lib/duration';
import { formatNum } from '../../lib/finance';
import { t } from '../../lib/i18n';
import { pace, recentPace, weeksAtPace } from '../../lib/learningPace';
import { ICON } from '../../components/ui/icons';
import { LearningItemSheet } from './LearningItemSheet';
import { LogSessionSheet } from './LogSessionSheet';
import { PartsSheet } from './PartsSheet';
import { PlanList } from './PlanList';

const UNIT_SUFFIX: Record<LearningItem['progressUnit'], string> = {
  percent: '%',
  pages: 'стр.',
  lessons: 'уроков',
  hours: 'ч',
};

/** Экран одного материала: успеваю ли к сроку, план и занятия.
 *
 *  Открывается только у материала со сроком или планом — у книги без того и
 *  другого показывать здесь нечего, ей хватает карточки в списке. */
export function LearningItemPage() {
  const { id } = useParams<{ id: string }>();
  const [logOpen, setLogOpen] = useState(false);
  const [partsOpen, setPartsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const item = useLiveQuery(() => (id ? db.learningItems.get(id) : undefined), [id]);
  const logs = useLiveQuery(
    () => (id ? db.learningLogs.where('itemId').equals(id).toArray() : []),
    [id],
    [] as LearningLog[],
  );
  const parts = useLiveQuery(
    () => (id ? db.learningParts.where('itemId').equals(id).toArray() : []),
    [id],
    [] as LearningPart[],
  );

  const liveLogs = useMemo(() => alive(logs ?? []), [logs]);
  const liveParts = useMemo(
    () => alive(parts ?? []).sort((a, b) => a.sortOrder - b.sortOrder),
    [parts],
  );

  const sched = useMemo(() => {
    if (!item) return null;
    return pace({
      target: item.progressTarget,
      current: item.progressCurrent,
      from: toKey(new Date(item.startedAt ?? item.createdAt)),
      due: item.dueDate ?? null,
    });
  }, [item]);

  if (!item) return <Screen title={t('Материал')} backTo="/more/learning" children={null} />;

  const unit = t(UNIT_SUFFIX[item.progressUnit]);
  const perWeekActual = recentPace(liveLogs) / 60; // минуты в неделю → часы
  const done = liveParts.filter((p) => p.doneAt);

  return (
    <Screen
      title={item.title}
      backTo="/more/learning"
      subtitle={item.author || undefined}
      right={
        <button
          type="button"
          onClick={() => setEditOpen(true)}
          aria-label={t('Изменить материал')}
          className="flex size-11 items-center justify-center text-muted active:opacity-60"
        >
          <Pencil size={ICON.header} />
        </button>
      }
    >
      <div className="space-y-3">
        {sched ? (
          <Summary item={item} sched={sched} unit={unit} perWeekActual={perWeekActual} />
        ) : (
          <p className="card p-4 text-sm text-muted">
            {t('У материала нет срока. Поставьте его в карточке — появится график и темп.')}
          </p>
        )}

        {sched && <Chart item={item} sched={sched} />}

        <Button className="flex w-full items-center justify-center gap-2" onClick={() => setLogOpen(true)}>
          <Clock size={ICON.base} />
          {t('Записать занятие')}
        </Button>

        <section>
          <div className="mb-2 flex items-baseline gap-2 px-1">
            <h2 className="text-sm font-semibold text-muted">{t('План')}</h2>
            <span className="ml-auto text-xs tabular-nums text-muted">
              {liveParts.length > 0
                ? t('{a} из {b}', { a: done.length, b: liveParts.length })
                : t('пусто')}
            </span>
          </div>
          {liveParts.length > 0 ? (
            <PlanList parts={liveParts} unit={unit} />
          ) : (
            <p className="card p-4 text-sm text-muted">
              {t('Разбейте материал на части — главы, темы, дисциплины. Прогресс пойдёт по ним.')}
            </p>
          )}
          <button
            type="button"
            onClick={() => setPartsOpen(true)}
            className="mt-2 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-sm font-semibold text-text active:opacity-70"
          >
            <Plus size={ICON.action} />
            {liveParts.length > 0 ? t('Изменить план') : t('Составить план')}
          </button>
        </section>

        <Sessions logs={liveLogs} />
      </div>

      <LearningItemSheet open={editOpen} onClose={() => setEditOpen(false)} item={item} />
      <LogSessionSheet open={logOpen} onClose={() => setLogOpen(false)} item={item} />
      <PartsSheet
        open={partsOpen}
        onClose={() => setPartsOpen(false)}
        item={item}
        parts={liveParts}
      />
    </Screen>
  );
}

function Summary({
  item,
  sched,
  unit,
  perWeekActual,
}: {
  item: LearningItem;
  sched: NonNullable<ReturnType<typeof pace>>;
  unit: string;
  perWeekActual: number;
}) {
  const weeks = weeksAtPace(sched.remaining, perWeekActual);
  const finish = weeks === null ? null : addDaysKey(todayKey(), Math.round(weeks * 7));
  const lateWeeks =
    finish && item.dueDate
      ? Math.round(differenceInCalendarDays(fromKey(finish), fromKey(item.dueDate)) / 7)
      : null;

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-hairline bg-hairline">
      <Tile
        k={t('осталось')}
        v={formatNum(Math.round(sched.remaining))}
        u={unit}
        n={t('срок {date}', { date: formatRu(item.dueDate!) })}
      />
      <Tile
        k={t('нужно в неделю')}
        v={formatNum(Math.round(sched.perWeek * 10) / 10)}
        u={unit}
        n={t('осталось {n} дн.', { n: Math.max(0, sched.daysLeft) })}
      />
      <Tile
        k={t('твой темп')}
        v={perWeekActual > 0 ? formatNum(Math.round(perWeekActual * 10) / 10) : '—'}
        u={perWeekActual > 0 ? t('ч') : ''}
        n={perWeekActual > 0 ? t('за 28 дней') : t('нет записей')}
      />
      <Tile
        k={t('финиш')}
        v={finish ? formatRu(finish, 'LLL') : '—'}
        u={finish ? formatRu(finish, 'yyyy') : ''}
        n={
          lateWeeks === null
            ? t('появится после записей')
            : lateWeeks > 1
              ? t('+{n} нед. к сроку', { n: lateWeeks })
              : t('в срок')
        }
        warn={lateWeeks !== null && lateWeeks > 1}
      />
    </div>
  );
}

function Tile({
  k,
  v,
  u,
  n,
  warn,
}: {
  k: string;
  v: string;
  u: string;
  n: string;
  warn?: boolean;
}) {
  return (
    <div className="bg-surface p-3.5">
      <p className="text-2xs font-semibold uppercase tracking-wide text-muted">{k}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${warn ? 'text-warning' : ''}`}>
        {v}
        {u && <span className="ml-1 text-sm font-medium text-muted">{u}</span>}
      </p>
      <p className={`mt-0.5 text-xs ${warn ? 'text-warning' : 'text-muted'}`}>{n}</p>
    </div>
  );
}

/** План против факта: пунктир — где надо быть, сплошная — где ты. */
function Chart({
  item,
  sched,
}: {
  item: LearningItem;
  sched: NonNullable<ReturnType<typeof pace>>;
}) {
  const W = 300;
  const H = 96;
  const PAD = { l: 4, r: 4, t: 6, b: 6 };
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;

  const from = toKey(new Date(item.startedAt ?? item.createdAt));
  const total = Math.max(1, differenceInCalendarDays(fromKey(item.dueDate!), fromKey(from)));
  const gone = Math.min(total, Math.max(0, differenceInCalendarDays(fromKey(todayKey()), fromKey(from))));
  const x = (d: number) => PAD.l + (iw * d) / total;
  const y = (v: number) => PAD.t + ih - (ih * Math.min(1, v / item.progressTarget));

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-baseline">
        <h2 className="text-sm font-semibold">{t('Движение по графику')}</h2>
        <span className="ml-auto flex gap-3 text-2xs text-muted">
          <span>{t('план')}</span>
          <span className="text-success">{t('факт')}</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={t('Движение по графику')}>
        <line x1={PAD.l} y1={y(0)} x2={W - PAD.r} y2={y(0)} stroke="var(--app-hairline)" strokeWidth="1" />
        <line
          x1={PAD.l}
          y1={y(item.progressTarget)}
          x2={W - PAD.r}
          y2={y(item.progressTarget)}
          stroke="var(--app-hairline)"
          strokeWidth="1"
        />
        <line
          x1={x(0)}
          y1={y(0)}
          x2={x(total)}
          y2={y(item.progressTarget)}
          stroke="var(--app-muted)"
          strokeWidth="1.7"
          strokeDasharray="4 4"
        />
        <path
          d={`M ${x(0)} ${y(0)} L ${x(gone)} ${y(item.progressCurrent)}`}
          fill="none"
          stroke="var(--app-success)"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <circle cx={x(gone)} cy={y(item.progressCurrent)} r="4" fill="var(--app-success)" />
      </svg>
      <p
        className={`mt-2 text-xs font-semibold ${
          sched.overdue ? 'text-danger' : sched.onTrack ? 'text-success' : 'text-warning'
        }`}
      >
        {sched.overdue
          ? t('Срок прошёл')
          : sched.onTrack
            ? t('Идёшь по графику')
            : t('Отставание {n}', { n: formatNum(Math.round(sched.debt)) })}
      </p>
    </div>
  );
}

/** Занятия: неделя столбиками и последние записи. */
function Sessions({ logs }: { logs: LearningLog[] }) {
  const today = todayKey();
  const week = useMemo(() => {
    // Понедельник текущей недели — семь ячеек, чтобы пустые дни были видны.
    const iso = fromKey(today).getDay() || 7;
    const monday = addDaysKey(today, 1 - iso);
    return WEEKDAY_LABELS.map((label, i) => {
      const key = addDaysKey(monday, i);
      const minutes = logs
        .filter((l) => l.date === key)
        .reduce((sum, l) => sum + (l.minutes ?? 0), 0);
      return { label, minutes, isToday: key === today };
    });
  }, [logs, today]);

  const max = Math.max(60, ...week.map((d) => d.minutes));
  const weekTotal = week.reduce((s, d) => s + d.minutes, 0);
  const recent = logs
    .filter((l) => (l.minutes ?? 0) > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 6);

  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <h2 className="text-sm font-semibold text-muted">{t('Занятия')}</h2>
        <span className="ml-auto text-xs tabular-nums text-muted">
          {weekTotal > 0 ? t('{time} на этой неделе', { time: formatDuration(weekTotal) }) : t('пока пусто')}
        </span>
      </div>
      <div className="card p-4">
        <div className="flex h-20 items-end gap-1.5">
          {week.map((d) => (
            <div key={d.label} className="flex flex-1 flex-col items-center gap-1.5">
              <div
                className={`w-full rounded ${d.minutes > 0 ? 'bg-accent-fill' : 'bg-border'}`}
                style={{ height: `${d.minutes > 0 ? Math.max(8, (56 * d.minutes) / max) : 4}px` }}
              />
              <span className={`text-2xs ${d.isToday ? 'font-semibold text-text' : 'text-muted'}`}>
                {t(d.label)}
              </span>
            </div>
          ))}
        </div>
        {recent.length > 0 && (
          <ul className="mt-3 divide-y divide-hairline">
            {recent.map((l) => (
              <li key={l.id} className="flex items-baseline gap-3 py-2 text-sm">
                <span className="w-14 shrink-0 text-xs tabular-nums text-muted">
                  {l.date === today ? t('сегодня') : formatRu(l.date, 'd MMM')}
                </span>
                <span className="w-14 shrink-0 font-semibold tabular-nums text-accent">
                  {formatDuration(l.minutes ?? 0)}
                </span>
                <span className="truncate text-muted">{l.note}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
