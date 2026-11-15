import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../../lib/i18n';
import { playTick, unlockTick } from './tick';

// Общее время тренировки барабаном — как колесо таймера в «Часах» iPhone
// (просьба Влада 15.11.2026, канва design/sport-templates, артборд Time):
// два колеса, часы и минуты, крутятся пальцем по инерции, встают на деление,
// на каждом делении — тот же щелчок, что у барабана дней (tick.ts).

/** Шаг колеса, px: строка не ниже 44 (PROTOCOL §5.1), видно три строки. */
const ROW = 44;
const HOURS = [0, 1, 2, 3, 4, 5];
// ponytail: шаг 5 минут — длительность тренировки до минуты не нужна, а
// колесо из 12 делений впятеро короче; понадобится точнее — шаг 1.
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

/** Два колеса: часы и минуты. `value` — минуты всего; 0 — время не задано. */
export function DurationWheel({ value, onChange }: { value: number; onChange: (minutes: number) => void }) {
  // На сетку колёс встаёт всё значение целиком: 58 минут — это «1 ч 0 мин»,
  // а не «0 ч 0 мин» (отдельное округление остатка давало 60 → 0). Время не
  // на сетке приходит только синком; пока колёса не тронули, оно не меняется.
  const snapped = Math.min(HOURS[HOURS.length - 1] * 60 + MINUTES[MINUTES.length - 1], Math.round(value / 5) * 5);
  const h = Math.floor(snapped / 60);
  const m = snapped % 60;
  // Оба колеса могут встать в один тик: второе должно сложиться с уже новым
  // значением первого, а не с тем, что было на прошлом рендере.
  const cur = useRef({ h, m });
  useEffect(() => {
    cur.current = { h, m };
  }, [h, m]);
  const set = (part: 'h' | 'm', v: number) => {
    cur.current = { ...cur.current, [part]: v };
    onChange(cur.current.h * 60 + cur.current.m);
  };

  return (
    <div
      role="group"
      aria-label={t('Общее время тренировки')}
      data-testid="duration-wheel"
      className="relative flex justify-center gap-4 rounded-lh-btn border border-lh-border bg-lh-surface-2"
    >
      {/* Полоса выбора стоит на месте, числа едут под ней — как в колесе iOS. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-2.5 top-11 h-11 rounded-xl bg-lh-accent-dim ring-1 ring-inset ring-lh-accent-border"
      />
      <WheelColumn values={HOURS} value={h} onChange={(v) => set('h', v)} unit={t('ч')} label={t('Часы')} />
      <WheelColumn values={MINUTES} value={m} onChange={(v) => set('m', v)} unit={t('мин')} label={t('Минуты')} />
    </div>
  );
}

function WheelColumn({
  values,
  value,
  onChange,
  unit,
  label,
}: {
  values: number[];
  value: number;
  onChange: (v: number) => void;
  unit: string;
  label: string;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef(-1);
  // Куда колесо едет после тапа или стрелки; null — его крутят пальцем.
  const targetRef = useRef<number | null>(null);
  const [center, setCenter] = useState(() => Math.max(0, values.indexOf(value)));
  // JS-прокрутка сама слушает «Уменьшение движения» (PROTOCOL §6.1).
  const reduce = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);

  // Встать на значение: при открытии — скачком, без щелчков; своё же значение
  // приходит с тем же индексом и ничего не двигает.
  useLayoutEffect(() => {
    const rail = railRef.current;
    const i = values.indexOf(value);
    if (!rail || i < 0 || i === centerRef.current) return;
    if (centerRef.current < 0 || reduce) {
      centerRef.current = i;
      rail.scrollTop = i * ROW;
      setCenter(i);
    } else {
      rail.scrollTo({ top: i * ROW, behavior: 'smooth' });
    }
  }, [value, values, reduce]);

  const onScroll = () => {
    const rail = railRef.current;
    if (!rail) return;
    const i = Math.min(values.length - 1, Math.max(0, Math.round(rail.scrollTop / ROW)));
    if (i === centerRef.current) return;
    centerRef.current = i;
    setCenter(i);
    playTick();
    // Число уходит в форму сразу, на каждом делении: «Сохранить» или закрытие
    // через долю секунды после броска уже видят его. У барабана дней выбор
    // ждёт остановки ленты — там за ним пересчёт сводок, здесь форма лёгкая.
    // После тапа число уже отдано (pick): промежуточные по пути не в счёт.
    if (targetRef.current === null) onChange(values[i]);
    else if (i === targetRef.current) targetRef.current = null;
  };

  /** Тап по числу и стрелка знают число сразу — и отдают сразу, колесо
   *  доезжает следом: закрытие на полпути не оставит промежуточное. */
  const pick = (i: number) => {
    unlockTick();
    if (i === centerRef.current) return;
    targetRef.current = i;
    onChange(values[i]);
    railRef.current?.scrollTo({ top: i * ROW, behavior: reduce ? 'auto' : 'smooth' });
  };
  /** Палец на колесе — дальше ведёт он, а не начатая тапом прокрутка. */
  const grab = () => {
    targetRef.current = null;
    unlockTick();
  };

  // Клавиатура: Tab входит на выбранном числе, стрелки листают по делению.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const j = Math.min(values.length - 1, Math.max(0, center + (e.key === 'ArrowDown' ? 1 : -1)));
    pick(j);
    (railRef.current?.querySelectorAll('button')[j] as HTMLElement | undefined)?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={railRef}
      onScroll={onScroll}
      onTouchStart={grab}
      onTouchEnd={unlockTick}
      onPointerDown={grab}
      onKeyDown={onKeyDown}
      role="group"
      aria-label={label}
      // Затухание — 10px у края: соседние числа читаются в полную силу (AA),
      // гаснет только то, что уходит за край. contain — колесо не тянет за
      // собой прокрутку шторки.
      className="relative h-[132px] w-28 snap-y snap-mandatory overflow-y-auto overscroll-y-contain [mask-image:linear-gradient(180deg,transparent,#000_10px,#000_calc(100%_-_10px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div aria-hidden className="h-11" />
      {values.map((v, i) => {
        const sel = i === center;
        return (
          // Читалке и Tab виден только выбранный ряд — как в барабане дней.
          <button
            key={v}
            type="button"
            aria-label={`${v} ${unit}${sel ? t(', выбрано') : ''}`}
            aria-pressed={sel}
            aria-hidden={sel ? undefined : true}
            tabIndex={sel ? 0 : -1}
            onClick={() => pick(i)}
            className="flex h-11 w-full snap-center items-center justify-center gap-1.5"
          >
            <span className={`text-lg tabular-nums ${sel ? 'font-bold text-lh-accent' : 'text-lh-text-secondary'}`}>{v}</span>
            {/* Единица — только у выбранного числа, но место под неё держат все:
                иначе число прыгало бы вбок, проходя под полосой. */}
            <span className={`text-sm ${sel ? 'font-medium text-lh-text-primary' : 'invisible'}`}>{unit}</span>
          </button>
        );
      })}
      <div aria-hidden className="h-11" />
    </div>
  );
}
