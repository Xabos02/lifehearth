import { useEffect, useMemo, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { differenceInCalendarDays } from 'date-fns';
import { AlertCircle, Clock, Pencil } from 'lucide-react';
import { Screen } from '../../components/layout/Screen';
import { Button } from '../../components/ui/Button';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { LearningItem, LearningLog, LearningPart } from '../../db/types';
import { addDaysKey, formatRu, fromKey, todayKey, toKey, WEEKDAY_LABELS } from '../../lib/dates';
import { formatDuration } from '../../lib/duration';
import { formatNum } from '../../lib/finance';
import { t } from '../../lib/i18n';
import { forecastPerWeek, pace, recentPace, unitLabel, weeksAtPace } from '../../lib/learningPace';
import { ICON } from '../../components/ui/icons';
import { GCheckCircle } from '../../components/ui/glyphs';
import { KIND_ICONS, KIND_LABEL } from './kinds';
import { ProgressStepper } from './ProgressStepper';
import { LearningItemSheet } from './LearningItemSheet';
import { LogSessionSheet } from './LogSessionSheet';
import { PartsSheet } from './PartsSheet';
import { PlanList } from './PlanList';
import { repairPercentScale } from './plan';

/** Экран одного материала: успеваю ли к сроку, план и занятия.
 *
 *  Открывается только у материала со сроком или планом — у книги без того и
 *  другого показывать здесь нечего, ей хватает карточки в списке. */
export function LearningItemPage() {
  const { id } = useParams<{ id: string }>();
  const [logOpen, setLogOpen] = useState(false);
  const [partsOpen, setPartsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  // null — материала нет: undefined остаётся за загрузкой.
  const item = useLiveQuery(
    async () => (id ? ((await db.learningItems.get(id)) ?? null) : null),
    [id],
  );
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

  const goalTitle = useLiveQuery(
    async () => (item?.goalId ? ((await db.goals.get(item.goalId))?.title ?? '') : ''),
    [item?.goalId],
    '',
  );

  // Экран открывается и мимо списка (перезагрузка на нём, тихое обновление).
  useEffect(() => {
    void repairPercentScale();
  }, []);

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

  if (item === undefined) return <Screen title={t('Материал')} backTo="/more/learning" children={null} />;
  // Удалённый (здесь или на другом устройстве) — назад к списку, как заметка.
  // Было: удаление мягкое, get() отдавал строку с deletedAt, и экран оставался
  // открытым — с планом и «Записать занятие» у материала, которого уже нет.
  if (item === null || item.deletedAt) return <Navigate to="/more/learning" replace />;

  const perWeekActual = recentPace(liveLogs) / 60; // минуты в неделю → часы
  const perWeekForecast = forecastPerWeek(
    item.progressUnit,
    item.progressCurrent,
    toKey(new Date(item.startedAt ?? item.createdAt)),
    liveLogs,
  );
  const KindIcon = KIND_ICONS[item.kind];

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
          className="flex size-11 items-center justify-center text-lh-text-secondary active:opacity-60"
        >
          <Pencil size={ICON.header} />
        </button>
      }
    >
      <div className="space-y-6">
        <section className="space-y-4">
          <p className="flex items-center gap-2 px-1 text-xs text-lh-text-secondary">
            <KindIcon size={ICON.inline} className="shrink-0 text-lh-accent" aria-hidden />
            <span className="min-w-0 truncate">
              {t(KIND_LABEL[item.kind])}
              {goalTitle ? ` · ${t('цель «{title}»', { title: goalTitle })}` : ''}
            </span>
          </p>
          <ProgressStepper item={item} />
        </section>

        {sched ? (
          <Summary
            item={item}
            sched={sched}
            perWeekActual={perWeekActual}
            perWeekForecast={perWeekForecast}
          />
        ) : (
          <p className="card p-4 text-sm text-lh-text-secondary">
            {t('У материала нет срока. Поставьте его в карточке — появится график и темп.')}
          </p>
        )}

        {sched && <Chart item={item} sched={sched} />}

        <section>
          <div className="mb-1 flex items-center gap-2 px-1">
            <h2 className="lh-section">{t('План')}</h2>
            {liveParts.length > 0 && (
              <span className="text-xs tabular-nums text-lh-text-secondary">
                {t('{a} из {b}', { a: liveParts.filter((p) => p.doneAt).length, b: liveParts.length })}
              </span>
            )}
            <button
              type="button"
              onClick={() => setPartsOpen(true)}
              className="-mr-1 ml-auto flex h-11 items-center px-1 text-sm text-lh-accent active:opacity-60"
            >
              {liveParts.length > 0 ? t('Изменить план') : t('Составить план')}
            </button>
          </div>
          {liveParts.length > 0 ? (
            <PlanList parts={liveParts} unit={item.progressUnit} />
          ) : (
            <p className="card p-4 text-sm text-lh-text-secondary">
              {t('Разбейте материал на части — главы, темы, дисциплины. Прогресс пойдёт по ним.')}
            </p>
          )}
        </section>

        <Sessions logs={liveLogs} />

        <Button className="w-full" onClick={() => setLogOpen(true)}>
          <Clock size={ICON.base} className="shrink-0" />
          {t('Записать занятие')}
        </Button>
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
  perWeekActual,
  perWeekForecast,
}: {
  item: LearningItem;
  sched: NonNullable<ReturnType<typeof pace>>;
  perWeekActual: number;
  perWeekForecast: number;
}) {
  const weeks = weeksAtPace(sched.remaining, perWeekForecast);
  const finish = weeks === null ? null : addDaysKey(todayKey(), Math.round(weeks * 7));
  const lateWeeks =
    finish && item.dueDate
      ? Math.round(differenceInCalendarDays(fromKey(finish), fromKey(item.dueDate)) / 7)
      : null;
  const remaining = Math.round(sched.remaining);
  const perWeek = Math.round(sched.perWeek * 10) / 10;

  return (
    <div className="grid grid-cols-2 gap-3">
      <Tile
        k={t('осталось')}
        v={formatNum(remaining)}
        u={unitLabel(item.progressUnit, remaining)}
        n={t('срок {date}', { date: formatRu(item.dueDate!) })}
      />
      <Tile
        k={t('нужно в неделю')}
        v={formatNum(perWeek)}
        u={unitLabel(item.progressUnit, perWeek)}
        n={t('осталось {n} дн.', { n: Math.max(0, sched.daysLeft) })}
      />
      <Tile
        k={t('ваш темп')}
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
            ? // Прогноз у часов идёт по занятиям, у остальных — по прогрессу
              // (forecastPerWeek): обещать «после записей» книге — неправда.
              item.progressUnit === 'hours'
              ? t('появится после записей')
              : t('появится, когда пойдёт прогресс')
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
    <div className="card p-4">
      <p className={`text-2xl font-light leading-none tabular-nums ${warn ? 'text-warning' : ''}`}>
        {v}
        {u && <span className="ml-1 text-sm font-normal text-lh-text-secondary">{u}</span>}
      </p>
      <p className="mt-2 text-xs text-lh-text-secondary">{k}</p>
      <p className={`mt-0.5 text-2xs ${warn ? 'text-warning' : 'text-lh-text-secondary'}`}>{n}</p>
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
  const debt = Math.round(sched.debt);
  const W = 320;
  const H = 120;
  const PAD = { l: 4, r: 4, t: 6, b: 4 };
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;

  const from = toKey(new Date(item.startedAt ?? item.createdAt));
  const total = Math.max(1, differenceInCalendarDays(fromKey(item.dueDate!), fromKey(from)));
  const gone = Math.min(total, Math.max(0, differenceInCalendarDays(fromKey(todayKey()), fromKey(from))));
  const x = (d: number) => PAD.l + (iw * d) / total;
  const y = (v: number) => PAD.t + ih - (ih * Math.min(1, v / item.progressTarget));

  // Где «сегодня» по ширине: SVG растянут (preserveAspectRatio="none"), поэтому
  // точку и подпись ставим HTML-ом в процентах — иначе круг тянется в эллипс,
  // а подпись в ряду justify-between стояла бы посередине при любой дате.
  const todayPct = (x(gone) / W) * 100;

  const tone = sched.overdue ? 'text-danger' : sched.onTrack ? 'text-success' : 'text-warning';
  const StatusIcon = sched.onTrack && !sched.overdue ? GCheckCircle : AlertCircle;

  return (
    <section>
      <h2 className="lh-section mb-2.5 px-1">{t('Движение по графику')}</h2>
      <div className="card p-4">
        <p className="flex items-center gap-2 text-sm">
          <StatusIcon size={ICON.inline} className={`shrink-0 ${tone}`} aria-hidden />
          {sched.overdue
            ? t('Срок прошёл')
            : sched.onTrack
              ? t('Идёте по графику')
              : t('Отстаёте на {n}\u00A0{unit}', {
                  n: formatNum(debt),
                  unit: unitLabel(item.progressUnit, debt),
                })}
        </p>
        <div className="relative mt-4">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="block h-[120px] w-full"
            preserveAspectRatio="none"
            role="img"
            aria-label={t('Движение по графику')}
          >
            <line x1={0} y1={y(0)} x2={W} y2={y(0)} stroke="var(--app-hairline)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <line
              x1={0}
              y1={y(item.progressTarget / 2)}
              x2={W}
              y2={y(item.progressTarget / 2)}
              stroke="var(--app-hairline)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={x(0)}
              y1={y(0)}
              x2={x(total)}
              y2={y(item.progressTarget)}
              stroke="var(--lh-text-secondary)"
              strokeWidth="1.5"
              strokeDasharray="4 5"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={`M ${x(0)} ${y(0)} L ${x(gone)} ${y(item.progressCurrent)}`}
              fill="none"
              stroke="var(--lh-accent)"
              strokeWidth="2.2"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <span
            aria-hidden
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-lh-accent"
            style={{ left: `${todayPct}%`, top: `${(y(item.progressCurrent) / H) * 100}%` }}
          />
        </div>
        <div className="relative mt-2 flex justify-between text-xs tabular-nums text-lh-text-secondary">
          <span>{formatRu(from, 'd MMM')}</span>
          {/* ponytail: у краёв подпись наехала бы на даты (~50px при карточке от
              256px) — там её нет, место «сегодня» видно по точке. Нужна всегда —
              мерить ширины подписей. */}
          {todayPct >= 30 && todayPct <= 70 && (
            <span className="absolute top-0 -translate-x-1/2" style={{ left: `${todayPct}%` }}>
              {t('сегодня')}
            </span>
          )}
          <span>{formatRu(item.dueDate!, 'd MMM')}</span>
        </div>
        <div className="mt-3 flex gap-4 text-xs text-lh-text-secondary">
          <span className="flex items-center gap-1.5">
            <i className="w-4 border-t-2 border-lh-accent" aria-hidden />
            {t('Факт')}
          </span>
          <span className="flex items-center gap-1.5">
            <i className="w-4 border-t-2 border-dashed border-lh-text-secondary" aria-hidden />
            {t('План')}
          </span>
        </div>
      </div>
    </section>
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
      <div className="mb-2.5 flex items-baseline gap-2 px-1">
        <h2 className="lh-section">{t('Занятия')}</h2>
        <span className="ml-auto text-xs tabular-nums text-lh-text-secondary">
          {weekTotal > 0 ? t('{time} на этой неделе', { time: formatDuration(weekTotal) }) : t('пока пусто')}
        </span>
      </div>
      <div className="card p-4">
        <div className="flex h-20 items-end gap-1.5">
          {week.map((d) => (
            <div key={d.label} className="flex flex-1 flex-col items-center gap-1.5">
              <div
                className={`w-full rounded-md ${d.minutes > 0 ? 'bg-lh-accent' : 'bg-lh-surface-2'}`}
                style={{ height: `${d.minutes > 0 ? Math.max(8, (56 * d.minutes) / max) : 4}px` }}
              />
              <span className={`text-2xs ${d.isToday ? 'font-semibold text-lh-text-primary' : 'text-lh-text-secondary'}`}>
                {t(d.label)}
              </span>
            </div>
          ))}
        </div>
        {recent.length > 0 && (
          <ul className="mt-3 divide-y divide-lh-border">
            {recent.map((l) => (
              <li key={l.id} className="flex items-baseline gap-3 py-2 text-sm">
                <span className="w-14 shrink-0 text-xs tabular-nums text-lh-text-secondary">
                  {l.date === today ? t('сегодня') : formatRu(l.date, 'd MMM')}
                </span>
                <span className="w-14 shrink-0 font-semibold tabular-nums text-lh-accent">
                  {formatDuration(l.minutes ?? 0)}
                </span>
                <span className="truncate text-lh-text-secondary">{l.note}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
