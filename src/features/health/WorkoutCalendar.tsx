import { useMemo, useState } from 'react';
import { addMonths, endOfMonth, endOfWeek, format, isSameMonth, startOfMonth, startOfWeek } from 'date-fns';
import { GChevronLeft as ChevronLeft, GChevronRight as ChevronRight } from '../../components/ui/glyphs';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { t } from '../../lib/i18n';
import { WEEKDAY_LABELS, addDaysKey, dateLocale, fromKey, todayKey, toKey, weekStartKey } from '../../lib/dates';
import type { Workout } from '../../db/types';
import { workoutKind } from './workouts';

type Scale = 'week' | 'month';

interface Props {
  workouts: Workout[];
  selected: string;
  onSelect: (date: string) => void;
}

/** Спортивный календарь: неделя полосой или месяц сеткой, масштаб
 *  переключается. Точка под числом — тренировка, цвет — её вид; две точки —
 *  два занятия. Владелец: «горизонтальный мини-календарь с возможностью
 *  менять масштаб, месячный, недельный». */
export function WorkoutCalendar({ workouts, selected, onSelect }: Props) {
  const today = todayKey();
  const [scale, setScale] = useState<Scale>('week');
  // Опорный день: в неделе — понедельник показанной недели, в месяце — первое число.
  const [anchor, setAnchor] = useState(today);

  const byDay = useMemo(() => {
    const m = new Map<string, Workout[]>();
    for (const w of workouts) m.set(w.date, [...(m.get(w.date) ?? []), w]);
    return m;
  }, [workouts]);

  const weekStart = weekStartKey(anchor);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDaysKey(weekStart, i));

  const month = useMemo(() => {
    const first = startOfMonth(fromKey(anchor));
    const from = startOfWeek(first, { weekStartsOn: 1 });
    const to = endOfWeek(endOfMonth(first), { weekStartsOn: 1 });
    const days: { key: string; inMonth: boolean }[] = [];
    for (let d = from; d <= to; d = new Date(d.getTime() + 86_400_000)) {
      days.push({ key: toKey(d), inMonth: isSameMonth(d, first) });
    }
    return { label: format(first, 'LLLL yyyy', { locale: dateLocale() }), days };
  }, [anchor]);

  const shift = (dir: -1 | 1) => {
    if (scale === 'week') setAnchor(addDaysKey(weekStart, dir * 7));
    else setAnchor(toKey(addMonths(startOfMonth(fromKey(anchor)), dir)));
  };

  const weekLabel = (() => {
    const a = fromKey(weekStart);
    const b = fromKey(addDaysKey(weekStart, 6));
    const sameMonth = isSameMonth(a, b);
    return sameMonth
      ? `${format(a, 'd')} – ${format(b, 'd MMMM', { locale: dateLocale() })}`
      : `${format(a, 'd MMM', { locale: dateLocale() })} – ${format(b, 'd MMM', { locale: dateLocale() })}`;
  })();
  const title = scale === 'week' ? weekLabel : month.label.charAt(0).toUpperCase() + month.label.slice(1);

  const dots = (key: string) => {
    const list = byDay.get(key) ?? [];
    // Не больше трёх точек: четвёртая уже не читается на 40px.
    return list.slice(0, 3).map((w) => workoutKind(w.type).color);
  };

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-lg font-semibold">{title}</h2>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label={scale === 'week' ? t('Предыдущая неделя') : t('Предыдущий месяц')}
            onClick={() => shift(-1)}
            className={`shrink-0 rounded-lg p-1.5 text-muted active:opacity-60 ${HIT_SLOP_44}`}
          >
            <ChevronLeft size={ICON.header} />
          </button>
          <button
            type="button"
            aria-label={scale === 'week' ? t('Следующая неделя') : t('Следующий месяц')}
            onClick={() => shift(1)}
            className={`ml-1 shrink-0 rounded-lg p-1.5 text-muted active:opacity-60 ${HIT_SLOP_44}`}
          >
            <ChevronRight size={ICON.header} />
          </button>
        </div>
      </div>

      {scale === 'week' ? (
        <div className="grid grid-cols-7 gap-1" data-testid="workout-week">
          {weekDays.map((key, i) => (
            <DayCell
              key={key}
              dateKey={key}
              weekday={t(WEEKDAY_LABELS[i])}
              day={format(fromKey(key), 'd')}
              dots={dots(key)}
              isToday={key === today}
              isSelected={key === selected}
              muted={false}
              count={(byDay.get(key) ?? []).length}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-7" data-testid="workout-month">
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="pb-1 text-center text-xs font-medium text-muted">
              {t(label)}
            </div>
          ))}
          {month.days.map((d) => (
            <DayCell
              key={d.key}
              dateKey={d.key}
              day={format(fromKey(d.key), 'd')}
              dots={dots(d.key)}
              isToday={d.key === today}
              isSelected={d.key === selected}
              muted={!d.inMonth}
              count={(byDay.get(d.key) ?? []).length}
              onSelect={onSelect}
              square
            />
          ))}
        </div>
      )}

      <div className="mt-3">
        <SegmentedControl<Scale>
          options={[
            { value: 'week', label: t('Неделя') },
            { value: 'month', label: t('Месяц') },
          ]}
          value={scale}
          onChange={(v) => {
            setScale(v);
            setAnchor(selected);
          }}
        />
      </div>
    </div>
  );
}

function DayCell({
  dateKey,
  weekday,
  day,
  dots,
  isToday,
  isSelected,
  muted,
  count,
  onSelect,
  square = false,
}: {
  dateKey: string;
  weekday?: string;
  day: string;
  dots: string[];
  isToday: boolean;
  isSelected: boolean;
  muted: boolean;
  count: number;
  onSelect: (key: string) => void;
  square?: boolean;
}) {
  const label = `${format(fromKey(dateKey), 'd MMMM yyyy', { locale: dateLocale() })}${
    count ? t(', тренировок: {n}', { n: count }) : ''
  }${isSelected ? t(', выбрано') : ''}`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={isSelected}
      onClick={() => onSelect(dateKey)}
      className={`relative flex flex-col items-center justify-center gap-0.5 rounded-xl text-sm transition-colors ${
        square ? 'aspect-square' : 'py-2'
      } ${
        isSelected
          ? 'bg-accent-fill font-semibold text-white'
          : muted
            ? 'text-muted'
            : 'text-text active:bg-surface-2'
      } ${isToday && !isSelected ? 'ring-1 ring-accent' : ''}`}
    >
      {weekday && <span className={`text-[11px] font-medium ${isSelected ? 'text-white/80' : 'text-muted'}`}>{weekday}</span>}
      <span>{day}</span>
      <span className="flex h-1.5 items-center gap-0.5" aria-hidden>
        {dots.map((c, i) => (
          <span key={i} className="size-1.5 rounded-full" style={{ background: isSelected ? 'white' : c }} />
        ))}
      </span>
    </button>
  );
}
