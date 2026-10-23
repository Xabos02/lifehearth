import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type TouchEvent } from 'react';
import { addMonths, format, startOfMonth } from 'date-fns';
import { GChevronLeft as ChevronLeft, GChevronRight as ChevronRight } from '../../components/ui/glyphs';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { t } from '../../lib/i18n';
import { WEEKDAY_LABELS, addDaysKey, dateLocale, fromKey, monthGridKeys, todayKey, toKey } from '../../lib/dates';
import type { Workout } from '../../db/types';
import { resolveKind } from './workouts';
import { sessionCount } from './workoutStats';
import { playTick, unlockTick } from './tick';

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

/** Спортивный календарь: дни барабаном или месяц сеткой, масштаб
 *  переключается. Точка под числом — вид тренировки своим цветом;
 *  занятие из нескольких видов даёт несколько точек, а считается одним. Владелец: «горизонтальный мини-календарь с возможностью
 *  менять масштаб, месячный, недельный». С 22.10.2026 (задача 38) вместо
 *  недели Пн–Вс — барабан, как колесо будильника iOS: «крутить пальцем, там
 *  есть и звук, и характерное пролистывание». Канва design/sport-exercises (А). */
export function WorkoutCalendar({ workouts, selected, onSelect, scale, onScale }: Props) {
  const today = todayKey();
  // Опорный день месяца. Стартует с выбранного, а не с сегодня: после «Спорт →
  // Замеры → Спорт» календарь перемонтируется и должен показать месяц
  // выбранного дня.
  const [anchor, setAnchor] = useState(selected);

  const byDay = useMemo(() => {
    const m = new Map<string, Workout[]>();
    for (const w of workouts) m.set(w.date, [...(m.get(w.date) ?? []), w]);
    return m;
  }, [workouts]);

  const month = useMemo(
    () => ({
      label: format(startOfMonth(fromKey(anchor)), 'LLLL yyyy', { locale: dateLocale() }),
      days: monthGridKeys(anchor),
    }),
    [anchor],
  );

  const shift = (dir: -1 | 1) => setAnchor(toKey(addMonths(startOfMonth(fromKey(anchor)), dir)));

  // В барабане заголовок — месяц выбранного дня: недели как рамки больше нет.
  const label = scale === 'week' ? format(fromKey(selected), 'LLLL yyyy', { locale: dateLocale() }) : month.label;
  const title = label.charAt(0).toUpperCase() + label.slice(1);

  const dots = (key: string) => {
    const list = byDay.get(key) ?? [];
    // Не больше трёх точек: четвёртая уже не читается на 40px.
    return list.slice(0, 3).map((w) => resolveKind(w).color);
  };

  // Свайп пальцем влево/вправо в месячной сетке — на месяц, как в Apple
  // Fitness. preventDefault не зовём: вертикальная прокрутка страницы через
  // календарь не трогается, свайп нужен только по горизонтали. Барабан дней
  // крутится сам — нативной прокруткой.
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
      {/* Высота строки — под кнопку «Сегодня»: появляясь, она не толкает барабан вниз. */}
      <div className="mb-3 flex min-h-11 items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-lg font-light">{title}</h2>
        {scale === 'month' ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              aria-label={t('Предыдущий месяц')}
              onClick={() => shift(-1)}
              className={`shrink-0 rounded-lg p-1.5 text-lh-text-secondary active:opacity-60 ${HIT_SLOP_44}`}
            >
              <ChevronLeft size={ICON.header} />
            </button>
            <button
              type="button"
              aria-label={t('Следующий месяц')}
              onClick={() => shift(1)}
              className={`ml-1 shrink-0 rounded-lg p-1.5 text-lh-text-secondary active:opacity-60 ${HIT_SLOP_44}`}
            >
              <ChevronRight size={ICON.header} />
            </button>
          </div>
        ) : (
          selected !== today && (
            <button
              type="button"
              onClick={() => onSelect(today)}
              className={`shrink-0 rounded-full border border-lh-border-strong px-3.5 py-1.5 text-sm font-medium text-lh-accent active:opacity-70 ${HIT_SLOP_44}`}
            >
              {t('Сегодня')}
            </button>
          )
        )}
      </div>

      {scale === 'week' ? (
        <DayWheel byDay={byDay} selected={selected} today={today} onSelect={onSelect} />
      ) : (
        <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div className="grid grid-cols-7" data-testid="workout-month">
            {WEEKDAY_LABELS.map((label) => (
              <div key={label} className="pb-1 text-center text-xs font-medium text-lh-text-secondary">
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
                // Серый день соседнего месяца листает сетку на свой месяц — как в
                // «Календаре»: иначе выбранный день висел серым на краю, а
                // сводка под сеткой была уже про другой месяц.
                onSelect={(key) => {
                  if (!d.inMonth) setAnchor(key);
                  onSelect(key);
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Узкий, справа: во всю ширину он читался как вторые вкладки экрана
          под «Спорт | Замеры» и как переключатель того, что ниже него. */}
      <div className="mt-3 flex justify-end">
        <div className="w-40">
          <SegmentedControl<Scale>
            options={[
              { value: 'week', label: t('Дни') },
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
  day,
  dots,
  isToday,
  isSelected,
  muted,
  future,
  count,
  onSelect,
}: {
  dateKey: string;
  day: string;
  dots: string[];
  isToday: boolean;
  isSelected: boolean;
  muted: boolean;
  /** День ещё не наступил: выбрать нельзя — тренировку туда не записать. */
  future: boolean;
  count: number;
  onSelect: (key: string) => void;
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
      className={`relative flex aspect-square flex-col items-center justify-center gap-0.5 rounded-xl text-sm transition-colors ${HIT_SLOP_44} ${
        isSelected
          ? 'bg-lh-accent font-semibold text-lh-bg'
          : muted || future
            ? 'text-lh-text-secondary'
            : 'text-lh-text-primary active:bg-lh-surface-2'
      } ${isToday && !isSelected ? 'ring-1 ring-lh-accent' : ''}`}
    >
      <span>{day}</span>
      <span className="flex h-1.5 items-center gap-0.5" aria-hidden>
        {dots.map((c, i) => (
          <span key={i} className="size-1.5 rounded-full" style={{ background: isSelected ? 'white' : c }} />
        ))}
      </span>
    </button>
  );
}

/** Шаг барабана, px: на 375 видно семь дней, ячейка шире 44 (PROTOCOL §5.1). */
const WHEEL_STEP = 48;
// ponytail: барабан держит 120 дней назад и достраивается, когда выбор
// подходит к левому краю ближе двух недель; совсем далёкое — через «Месяц».
const WHEEL_BACK = 120;

interface WheelInfo {
  key: string;
  dots: string[];
  count: number;
}

/** Дни барабаном: крутится пальцем по инерции, встаёт на ближайший день,
 *  на каждом дне — щелчок. Правый край — сегодня: в будущее не крутится,
 *  тренировку туда не записать. Выбор уходит наверх, когда лента встала, —
 *  иначе на быстром броске вкладка пересчитывала бы сводки на каждом дне. */
function DayWheel({
  byDay,
  selected,
  today,
  onSelect,
}: {
  byDay: Map<string, Workout[]>;
  selected: string;
  today: string;
  onSelect: (key: string) => void;
}) {
  const first = useMemo(() => {
    const back = addDaysKey(today, -WHEEL_BACK);
    const near = addDaysKey(selected, -14);
    return near < back ? near : back;
  }, [today, selected]);
  const info = useMemo(() => {
    const out: WheelInfo[] = [];
    for (let key = first; key <= today; key = addDaysKey(key, 1)) {
      const list = byDay.get(key) ?? [];
      // Не больше трёх точек: четвёртая уже не читается.
      out.push({ key, dots: list.slice(0, 3).map((w) => resolveKind(w).color), count: sessionCount(list, key, key) });
    }
    return out;
  }, [first, today, byDay]);
  const infoRef = useRef(info);
  useEffect(() => {
    infoRef.current = info;
  }, [info]);

  const railRef = useRef<HTMLDivElement>(null);
  // Лица дней (внутренний span): поворот и угасание — на них, а не на кнопке,
  // иначе уменьшенная кнопка ужимала свою зону касания меньше 44px.
  const faces = useRef<(HTMLSpanElement | null)[]>([]);
  const centerRef = useRef(-1);
  const firstRef = useRef(first);
  const prevSelected = useRef(selected);
  const selectedRef = useRef(selected);
  const onSelectRef = useRef(onSelect);
  const settle = useRef<number | undefined>(undefined);
  const [center, setCenter] = useState(() => info.findIndex((d) => d.key === selected));
  // JS-анимация сама слушает «Уменьшение движения» (PROTOCOL §6.1).
  const reduce = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);

  /** Цилиндр, как у колеса iOS: дни от центра уменьшаются, гаснут и
   *  уходят за край. Пишется прямо в стиль — без перерисовки React на
   *  каждый кадр прокрутки; считаются только дни рядом с центром. */
  const paint = (scrollLeft: number) => {
    const c = scrollLeft / WHEEL_STEP;
    const from = Math.max(0, Math.floor(c) - 5);
    const to = Math.min(info.length - 1, Math.ceil(c) + 5);
    for (let i = from; i <= to; i++) {
      const el = faces.current[i];
      if (!el) continue;
      const off = i - c;
      const a = Math.min(Math.abs(off), 4);
      // Выбранный и по два дня с боков — в полную силу: их читают, контраст
      // AA (PROTOCOL §1.2). Гаснет только то, что уходит за край, как в маске.
      el.style.opacity = String(Math.max(0.25, 1 - Math.max(0, a - 2) * 0.25));
      if (!reduce) el.style.transform = `perspective(420px) rotateY(${(-off * 18).toFixed(1)}deg) scale(${(1 - a * 0.07).toFixed(3)})`;
    }
  };

  useEffect(() => {
    selectedRef.current = selected;
    onSelectRef.current = onSelect;
  }, [selected, onSelect]);
  // Ушли с барабана («Месяц», «Замеры»), пока лента доезжала: день под
  // полосой всё равно выбран — иначе «Месяц» открывался на прежней дате.
  useEffect(
    () => () => {
      if (settle.current === undefined) return;
      window.clearTimeout(settle.current);
      const key = infoRef.current[centerRef.current]?.key;
      if (key && key !== selectedRef.current) onSelectRef.current(key);
    },
    [],
  );

  // Встать на выбранный день: при открытии и когда день выбран снаружи
  // («Сегодня», месячная сетка). Свой же выбор после остановки ленты сюда
  // приходит с тем же индексом — и ничего не двигает.
  useLayoutEffect(() => {
    const rail = railRef.current;
    const i = info.findIndex((d) => d.key === selected);
    if (!rail || i < 0) return;
    const shifted = firstRef.current !== first;
    firstRef.current = first;
    const changed = prevSelected.current !== selected;
    prevSelected.current = selected;
    // Новые данные (синк с другого устройства, своя же запись) пересобирают
    // info — ленту это не двигает: посреди прокрутки она уезжала назад.
    if (centerRef.current >= 0 && !shifted && (!changed || i === centerRef.current)) return;
    // Скачок без прокрутки — при открытии и когда лента достроилась слева
    // (индексы сдвинулись, а день на месте). «Сегодня» — прокруткой, со
    // щелчками по пути, как колесо iOS.
    if (centerRef.current < 0 || shifted || reduce) {
      centerRef.current = i;
      rail.scrollLeft = i * WHEEL_STEP;
      setCenter(i);
      paint(rail.scrollLeft);
    } else {
      rail.scrollTo({ left: i * WHEEL_STEP, behavior: 'smooth' });
    }
    // paint читает info и reduce из того же рендера — отдельной зависимостью не нужен.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, info, first, reduce]);

  const onScroll = () => {
    const rail = railRef.current;
    if (!rail) return;
    paint(rail.scrollLeft);
    const i = Math.min(info.length - 1, Math.max(0, Math.round(rail.scrollLeft / WHEEL_STEP)));
    if (i !== centerRef.current) {
      centerRef.current = i;
      setCenter(i);
      playTick();
    }
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      settle.current = undefined;
      const key = info[centerRef.current]?.key;
      if (key && key !== selectedRef.current) onSelect(key);
    }, 120);
  };

  const setFace = useMemo(
    () => (i: number, el: HTMLSpanElement | null) => {
      faces.current[i] = el;
    },
    [],
  );
  const pick = useMemo(
    () => (i: number) => {
      unlockTick();
      railRef.current?.scrollTo({ left: i * WHEEL_STEP, behavior: reduce ? 'auto' : 'smooth' });
    },
    [reduce],
  );

  // Клавиатура: в барабан Tab входит на выбранном дне (остальные вне порядка
  // фокуса — иначе первый Tab уводил ленту на 120 дней назад), стрелки
  // листают по дню.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const j = Math.min(info.length - 1, Math.max(0, center + (e.key === 'ArrowRight' ? 1 : -1)));
    pick(j);
    (faces.current[j]?.parentElement as HTMLElement | null | undefined)?.focus({ preventScroll: true });
  };

  const centerKey = info[center]?.key ?? selected;
  const caption = format(fromKey(centerKey), 'EEEE, d MMMM', { locale: dateLocale() });
  const rel =
    centerKey === today
      ? t('сегодня')
      : centerKey === addDaysKey(today, -1)
        ? t('вчера')
        : centerKey === addDaysKey(today, -2)
          ? t('позавчера')
          : null;

  return (
    <div>
      <div className="relative -mx-4">
        {/* Полоса выбора стоит на месте, дни едут под ней — как в колесе iOS. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0.5 left-1/2 w-[46px] -translate-x-1/2 rounded-xl bg-lh-accent-dim ring-1 ring-inset ring-lh-accent-border"
        />
        <div
          ref={railRef}
          onScroll={onScroll}
          onTouchStart={unlockTick}
          onTouchEnd={unlockTick}
          onPointerDown={unlockTick}
          onKeyDown={onKeyDown}
          role="group"
          aria-label={t('Дни')}
          data-testid="workout-week"
          // Затухание маски — 32px по краю, а не доля ширины: на 320 доля
          // залезала на второй день от центра.
          className="relative flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [mask-image:linear-gradient(90deg,transparent,#000_32px,#000_calc(100%_-_32px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div aria-hidden className="w-[calc(50%_-_24px)] shrink-0" />
          {info.map((d, i) => (
            <WheelDay key={d.key} d={d} index={i} sel={i === center} setFace={setFace} onPick={pick} />
          ))}
          <div aria-hidden className="w-[calc(50%_-_24px)] shrink-0" />
        </div>
      </div>
      <p className="mt-2 text-center text-sm text-lh-text-secondary" data-testid="wheel-caption">
        <span className="font-medium text-lh-text-primary">{caption.charAt(0).toUpperCase() + caption.slice(1)}</span>
        {rel && ` · ${rel}`}
      </p>
    </div>
  );
}

const WheelDay = memo(function WheelDay({
  d,
  index,
  sel,
  setFace,
  onPick,
}: {
  d: WheelInfo;
  index: number;
  sel: boolean;
  setFace: (i: number, el: HTMLSpanElement | null) => void;
  onPick: (i: number) => void;
}) {
  const date = fromKey(d.key);
  const label = `${format(date, 'd MMMM yyyy', { locale: dateLocale() })}${d.count ? t(', тренировок: {n}', { n: d.count }) : ''}${
    sel ? t(', выбрано') : ''
  }`;
  return (
    // Читалке виден только выбранный день: 120+ кнопок подряд она прокручивала
    // бы лентой и меняла выбор на каждой. Остальные дни — через «Месяц».
    <button
      type="button"
      aria-label={label}
      aria-pressed={sel}
      aria-hidden={sel ? undefined : true}
      tabIndex={sel ? 0 : -1}
      onClick={() => onPick(index)}
      className="flex h-[76px] w-[48px] shrink-0 snap-center items-center justify-center"
    >
      <span ref={(el) => setFace(index, el)} className="flex flex-col items-center gap-0.5">
        <span className={`text-2xs font-medium ${sel ? 'text-lh-accent' : 'text-lh-text-secondary'}`}>
          {t(WEEKDAY_LABELS[(date.getDay() + 6) % 7])}
        </span>
        <span className={`text-lg tabular-nums ${sel ? 'font-bold text-lh-accent' : 'font-medium text-lh-text-primary'}`}>{format(date, 'd')}</span>
        <span className="flex h-1.5 items-center gap-0.5" aria-hidden>
          {d.dots.map((c, i) => (
            <span key={i} className="size-1.5 rounded-full" style={{ background: c }} />
          ))}
        </span>
      </span>
    </button>
  );
});
