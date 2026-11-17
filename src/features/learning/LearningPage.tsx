import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLoaded } from '../../hooks/useLoaded';
import { AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import { Fab } from '../../components/layout/Fab';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { LearningItem } from '../../db/types';
import { formatNum } from '../../lib/finance';
import { LearningItemSheet } from './LearningItemSheet';
import { LogSessionSheet } from './LogSessionSheet';
import { repairPercentScale } from './plan';
import { KIND_ICONS, KIND_LABEL } from './kinds';
import { pace, unitLabel } from '../../lib/learningPace';
import { formatRu, toKey } from '../../lib/dates';
import { formatMinutes } from '../health/workoutStats';
import { startOfWeek } from 'date-fns';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import {
  GLearning as GraduationCap,
} from '../../components/ui/glyphs';

type Filter = 'inProgress' | 'planned' | 'done';


const EMPTY_HINTS: Record<Filter, string> = {
  inProgress: 'Нажмите + и добавьте книгу, курс или статью.',
  planned: 'Сюда попадает то, что вы планируете изучить.',
  done: 'Завершённые материалы появятся здесь.',
};

/** График материала: считается только когда у него есть срок. */
function schedule(item: LearningItem) {
  return pace({
    target: item.progressTarget,
    current: item.progressCurrent,
    // Пока материал не начат, планом считается день заведения: иначе первый
    // же расчёт делил бы на ноль дней.
    from: item.startedAt ? toKey(new Date(item.startedAt)) : toKey(new Date(item.createdAt)),
    due: item.dueDate ?? null,
  });
}

function progressLabel(item: LearningItem): string {
  switch (item.progressUnit) {
    case 'pages':
      return t('стр. {a} из {b}', { a: formatNum(item.progressCurrent), b: formatNum(item.progressTarget) });
    case 'lessons':
      return t('уроков {a} из {b}', { a: formatNum(item.progressCurrent), b: formatNum(item.progressTarget) });
    case 'hours':
      return t('{a} из {b}\u00A0ч', { a: formatNum(item.progressCurrent), b: formatNum(item.progressTarget) });
    case 'percent':
      return `${item.progressCurrent}%`;
  }
}


function LearningCard({
  item,
  onOpen,
  onLog,
}: {
  item: LearningItem;
  onOpen: () => void;
  onLog: () => void;
}) {
  const Icon = KIND_ICONS[item.kind];
  const pct =
    item.progressTarget > 0 ? (100 * item.progressCurrent) / item.progressTarget : 0;
  const sched = schedule(item);
  const debt = sched ? Math.round(sched.debt) : 0;
  const perWeek = sched ? Math.round(sched.perWeek * 10) / 10 : 0;
  const finished = item.status === 'done' || item.status === 'dropped';
  // Где человек должен быть по плану — засечка на полосе. Без срока её нет.
  const planPct = sched ? Math.min(100, (100 * sched.planned) / item.progressTarget) : null;
  const meta = [
    t(KIND_LABEL[item.kind]),
    item.dueDate && !finished
      ? t('до {date}', { date: formatRu(item.dueDate) })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div onClick={onOpen} className="card p-4 active:opacity-90">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 text-lh-accent">
          <Icon size={ICON.header} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-2xs text-lh-text-secondary">
            {meta}
            {item.status === 'dropped' && <> · {t('Брошено')}</>}
          </p>
          <p className="mt-0.5 font-semibold leading-snug">{item.title}</p>
          {item.author && <p className="truncate text-xs text-lh-text-secondary">{item.author}</p>}
        </div>
      </div>
      <div className="relative mt-3.5">
        <div className="h-1.5 overflow-hidden rounded-full bg-lh-surface-2">
          <div
            className={`h-full rounded-full ${item.status === 'done' ? 'bg-success' : 'bg-lh-accent'}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
        {planPct !== null && !sched?.done && (
          // Засечка плана поверх полосы: видно разрыв, а не только заполнение.
          <span
            aria-hidden
            className="absolute -top-0.5 h-2.5 w-0.5 rounded-full bg-lh-text-primary/60"
            style={{ left: `${planPct}%` }}
          />
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs tabular-nums">
        <span className="text-lh-text-secondary">{progressLabel(item)}</span>
        {sched && !sched.done ? (
          <span
            className={`flex items-center gap-1 ${
              sched.overdue ? 'text-danger' : sched.onTrack ? 'text-success' : 'text-warning'
            }`}
          >
            {sched.overdue ? (
              <AlertCircle size={ICON.inline} />
            ) : sched.onTrack ? (
              <CheckCircle2 size={ICON.inline} />
            ) : (
              <AlertCircle size={ICON.inline} />
            )}
            {sched.overdue
              ? t('Срок прошёл')
              : sched.onTrack
                ? t('Идёте по графику')
                : t('Отстаёте на {n}\u00A0{unit}', {
                    n: formatNum(debt),
                    unit: unitLabel(item.progressUnit, debt),
                  })}
          </span>
        ) : (
          !item.dueDate &&
          !finished && <span className="text-lh-text-secondary">{t('Без срока')}</span>
        )}
      </div>
      {item.status === 'inProgress' && (
        <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-lh-border pt-3">
          <span className="min-w-0 text-xs text-lh-text-secondary">
            {sched && !sched.done
              ? t('Нужно {n}\u00A0{unit} в неделю', {
                  n: formatNum(perWeek),
                  unit: unitLabel(item.progressUnit, perWeek),
                })
              : ''}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLog();
            }}
            aria-label={t('Записать занятие')}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-lh-surface-2 px-3.5 text-sm text-lh-accent active:opacity-70"
          >
            <Clock size={ICON.action} />
            {t('Записать занятие')}
          </button>
        </div>
      )}
    </div>
  );
}

export function LearningPage() {
  const [filter, setFilter] = useState<Filter>('inProgress');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<LearningItem | null>(null);
  const [logging, setLogging] = useState<LearningItem | null>(null);
  const navigate = useNavigate();

  const rows = useLiveQuery(() => db.learningItems.toArray(), []);
  const loaded = useLoaded(rows);
  const weekFrom = toKey(startOfWeek(new Date(), { weekStartsOn: 1 }));
  const weekMinutes = useLiveQuery(async () => {
    // Логи удалённого материала живут до очистки корзины — его минуты не в счёт.
    const live = new Set(alive(await db.learningItems.toArray()).map((i) => i.id));
    return alive(await db.learningLogs.where('date').aboveOrEqual(weekFrom).toArray())
      .filter((l) => live.has(l.itemId))
      .reduce((sum, l) => sum + (l.minutes || 0), 0);
  }, [weekFrom]);
  useEffect(() => {
    void repairPercentScale();
  }, []);
  const items = alive(rows ?? [])
    .filter((i) =>
      filter === 'done' ? i.status === 'done' || i.status === 'dropped' : i.status === filter,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const openCreate = () => {
    setEditing(null);
    setSheetOpen(true);
  };

  return (
    <Screen
      title={t('Обучение')}
      backTo="/home"
      subtitle={
        weekMinutes ? t('На этой неделе — {time} занятий', { time: formatMinutes(weekMinutes, t) }) : undefined
      }
    >
      <div className="space-y-3">
        <SegmentedControl<Filter>
          options={[
            { value: 'inProgress', label: t('В процессе') },
            { value: 'planned', label: t('В планах') },
            { value: 'done', label: t('Завершено') },
          ]}
          value={filter}
          onChange={setFilter}
        />
        {items.length === 0 ? (
          loaded && (
            <EmptyState
              icon={GraduationCap}
              title={t('Пока ничего нет')}
              hint={t(EMPTY_HINTS[filter])}
            />
          )
        ) : (
          items.map((item) => (
            <LearningCard
              key={item.id}
              item={item}
              onOpen={() => navigate(`/more/learning/${item.id}`)}
              onLog={() => setLogging(item)}
            />
          ))
        )}
      </div>
      <Fab onClick={openCreate} />
      <LearningItemSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        item={editing}
      />
      {logging && (
        <LogSessionSheet open onClose={() => setLogging(null)} item={logging} />
      )}
    </Screen>
  );
}
