import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLoaded } from '../../hooks/useLoaded';
import {
  BookOpen,
  Clock,
  FileText,
  FlaskConical,
  Languages,
  Video,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Fab } from '../../components/layout/Fab';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import type { LearningItem, LearningKind } from '../../db/types';
import { formatNum } from '../../lib/finance';
import { LearningItemSheet } from './LearningItemSheet';
import { LogSessionSheet } from './LogSessionSheet';
import { ProgressStepper } from './ProgressStepper';
import { pace } from '../../lib/learningPace';
import { fromKey, todayKey, toKey } from '../../lib/dates';
import { differenceInCalendarDays } from 'date-fns';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import {
  GLearning as GraduationCap,
} from '../../components/ui/glyphs';

type Filter = 'inProgress' | 'planned' | 'done';

const KIND_ICONS: Record<LearningKind, LucideIcon> = {
  book: BookOpen,
  course: GraduationCap,
  article: FileText,
  video: Video,
  research: FlaskConical,
  language: Languages,
};

const EMPTY_HINTS: Record<Filter, string> = {
  inProgress: 'Нажмите + и добавьте книгу, курс или статью.',
  planned: 'Сюда попадает то, что вы планируете изучить.',
  done: 'Завершённые материалы появятся здесь.',
};

/** Единица материала одним словом — для отставания: «на 12 ч», «на 40 стр.». */
const UNIT_SUFFIX: Record<LearningItem['progressUnit'], string> = {
  percent: '%',
  pages: 'стр.',
  lessons: 'уроков',
  hours: 'ч',
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
      return t('{a} из {b} ч', { a: formatNum(item.progressCurrent), b: formatNum(item.progressTarget) });
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
  const unit = t(UNIT_SUFFIX[item.progressUnit]);
  // Где человек должен быть по плану — засечка на полосе. Без срока её нет.
  const planPct = sched ? Math.min(100, (100 * sched.planned) / item.progressTarget) : null;

  return (
    <div
      onClick={onOpen}
      className="card p-4 active:opacity-90"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl tile-accent text-accent">
          <Icon size={ICON.header} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-semibold">{item.title}</p>
            {item.status === 'dropped' && (
              <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-muted">
                {t('Брошено')}
              </span>
            )}
          </div>
          {item.author && <p className="truncate text-sm text-muted">{item.author}</p>}
        </div>
        {sched && !sched.done && (
          <span
            className={`shrink-0 pt-0.5 text-xs font-semibold tabular-nums ${
              sched.overdue ? 'text-danger' : sched.onTrack ? 'text-muted' : 'text-warning'
            }`}
          >
            {dueLabel(item.dueDate!)}
          </span>
        )}
      </div>
      <div className="relative mt-3">
        <ProgressBar value={pct} />
        {planPct !== null && !sched?.done && (
          // Засечка плана поверх полосы: видно разрыв, а не только заполнение.
          <span
            aria-hidden
            className="absolute -top-0.5 h-2.5 w-0.5 rounded-full bg-text/60"
            style={{ left: `${planPct}%` }}
          />
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        {sched && !sched.done ? (
          <span
            className={`flex items-center gap-1 text-xs font-semibold ${
              sched.overdue ? 'text-danger' : sched.onTrack ? 'text-success' : 'text-warning'
            }`}
          >
            {sched.overdue
              ? t('Срок прошёл')
              : sched.onTrack
                ? t('Идёшь по графику')
                : t('Отстаёшь на {n} {unit}', { n: formatNum(Math.round(sched.debt)), unit })}
          </span>
        ) : (
          <span className="text-xs text-muted">{progressLabel(item)}</span>
        )}
        <span className="ml-auto text-xs text-muted">
          {sched && !sched.done
            ? t('{n} {unit} в неделю', { n: formatNum(Math.round(sched.perWeek * 10) / 10), unit })
            : progressLabel(item)}
        </span>
      </div>
      {item.status === 'inProgress' && (
        <div className="mt-2 flex items-center gap-2">
          <ProgressStepper item={item} />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onLog();
            }}
            aria-label={t('Записать занятие')}
            className="ml-auto flex h-11 items-center gap-1.5 rounded-xl bg-surface-2 px-3 text-sm font-semibold text-text active:opacity-70"
          >
            <Clock size={ICON.action} />
            {t('Занятие')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Сколько осталось до срока — короткой подписью справа от заголовка. */
function dueLabel(due: string): string {
  const days = differenceInCalendarDays(fromKey(due), fromKey(todayKey()));
  if (days < 0) return t('просрочено');
  if (days === 0) return t('сегодня');
  return t('{n} дн.', { n: days });
}

export function LearningPage() {
  const [filter, setFilter] = useState<Filter>('inProgress');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<LearningItem | null>(null);
  const [logging, setLogging] = useState<LearningItem | null>(null);
  const navigate = useNavigate();

  const rows = useLiveQuery(() => db.learningItems.toArray(), []);
  const loaded = useLoaded(rows);
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
    <Screen title={t('Обучение')} backTo="/home">
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
