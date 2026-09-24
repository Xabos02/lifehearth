import { useMemo, useRef, useState, type TouchEvent } from 'react';
import { addMonths, format, isSameMonth, startOfMonth } from 'date-fns';
import { GChevronLeft as ChevronLeft, GChevronRight as ChevronRight } from '../../components/ui/glyphs';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { t } from '../../lib/i18n';
import { WEEKDAY_LABELS, addDaysKey, dateLocale, fromKey, monthGridKeys, todayKey, toKey, weekStartKey } from '../../lib/dates';
import type { Workout } from '../../db/types';
import { resolveKind } from './workouts';
import { sessionCount } from './workoutStats';

export type Scale = 'week' | 'month';

interface Props {
  workouts: Workout[];
  selected: string;
  onSelect: (date: string) => void;
  /** Масштаб живёт у страницы: календарь перемонтируется при смене вкладки,
   *  и выбранный «Месяц» иначе сбрасывался на «Неделю». */
  scale: Scale;
  onScale: (scale: Scale) => void;
}

/** Спортивный календарь: неделя полосой или месяц сеткой, масштаб
 *  переключается. Точка под числом — вид тренировки своим цветом;
 *  занятие из нескольких видов даёт несколько точек, а считается одним. Владелец: «горизонтальный мини-календарь с возможностью
 *  менять масштаб, месячный, недельный». */
export function WorkoutCalendar({ workouts, selected, onSelect, scale, onScale }: Props) {
  const today = todayKey();
  // Опорный день: в неделе — понедельник показанной недели, в месяце — первое
  // число. Стартует с выбранного, а не с сегодня: после «Спорт → Замеры →
  // Спорт» календарь перемонтируется и должен показать неделю выбранного дня.
  const [anchor, setAnchor] = useState(selected);

  const byDay = useMemo(() => {
    const m = new Map<string, Workout[]>();
    for (const w of workouts) m.set(w.date, [...(m.get(w.date) ?? []), w]);
    return m;
  }, [workouts]);

  const weekStart = weekStartKey(anchor);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDaysKey(weekStart, i));

  const month = useMemo(
    () => ({
      label: format(startOfMonth(fromKey(anchor)), 'LLLL yyyy', { locale: dateLocale() }),
      days: monthGridKeys(anchor),
    }),
    [anchor],
  );

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
    return list.slice(0, 3).map((w) => resolveKind(w).color);
  };

  // Свайп пальцем влево/вправо — на неделю (в масштабе «месяц» — на месяц),
  // как в Apple Fitness. preventDefault не зовём: вертикальная прокрутка
  // страницы через календарь не трогается, свайп нужен только по горизонтали.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    const p = e.touches[0];
    touchStart.current = { x: p.clientX, y: p.clientY };
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start) return;
    const p = e.changedTouches[0];
    const dx = p.clientX - start.x;
    const dy = p.clientY - start.y;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) shift(dx < 0 ? 1 : -1);
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

      <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
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
              future={key > today}
              // Занятия, а не виды: силовая + растяжка одним занятием — одна.
              count={sessionCount(byDay.get(key) ?? [], key, key)}
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
              future={d.key > today}
              count={sessionCount(byDay.get(d.key) ?? [], d.key, d.key)}
              onSelect={onSelect}
              square
            />
          ))}
        </div>
      )}
      </div>

      {/* Узкий, справа: во всю ширину он читался как вторые вкладки экрана
          под «Спорт | Замеры» и как переключатель того, что ниже него. */}
      <div className="mt-3 flex justify-end">
        <div className="w-40">
          <SegmentedControl<Scale>
            options={[
              { value: 'week', label: t('Неделя') },
              { value: 'month', label: t('Месяц') },
            ]}
            value={scale}
            onChange={(v) => {
              onScale(v);
              setAnchor(selected);
            }}
          />
        </div>
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
  future,
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
  /** День ещё не наступил: выбрать нельзя — тренировку туда не записать. */
  future: boolean;
  count: number;
  onSelect: (key: string) => void;
  square?: boolean;
}) {
  const label = `${format(fromKey(dateKey), 'd MMMM yyyy', { locale: dateLocale() })}${
    count ? t(', тренировок: {n}', { n: count }) : ''
  }${isSelected ? t(', выбрано') : ''}${future ? t(', ещё не наступил') : ''}`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={isSelected}
      disabled={future}
      onClick={() => onSelect(dateKey)}
      className={`relative flex flex-col items-center justify-center gap-0.5 rounded-xl text-sm transition-colors ${HIT_SLOP_44} ${
        square ? 'aspect-square' : 'py-2'
      } ${
        isSelected
          ? 'bg-accent-fill font-semibold text-white'
          : muted || future
            ? 'text-muted'
            : 'text-text active:bg-surface-2'
      } ${isToday && !isSelected ? 'ring-1 ring-accent' : ''}`}
    >
      {/* Подпись дня — сплошным белым: white/80 на заливке давала 3,65:1. */}
      {weekday && <span className={`text-[11px] font-medium ${isSelected ? 'text-white' : 'text-muted'}`}>{weekday}</span>}
      <span>{day}</span>
      <span className="flex h-1.5 items-center gap-0.5" aria-hidden>
        {dots.map((c, i) => (
          <span key={i} className="size-1.5 rounded-full" style={{ background: isSelected ? 'white' : c }} />
        ))}
      </span>
    </button>
  );
}
