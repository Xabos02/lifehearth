import { useEffect, useRef } from 'react';
import { GChevronDown as ChevronDown, GPause as Pause, GPlay as Play, GRepeat as RotateCcw } from '../../components/ui/glyphs';
import { SkipForward } from 'lucide-react';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { t } from '../../lib/i18n';
import { formatClock, usePomodoro } from './pomodoro';

const R = 130;
const STROKE = 10;
const CIRC = 2 * Math.PI * R;

const PHASE_LABEL = { work: 'Фокус', break: 'Перерыв', long: 'Длинный перерыв' } as const;

/** Режим на весь экран: только время, круг и кнопки на тёмном фоне — как
 *  «На весь экран» в Focus To-Do. Пока круг идёт, экран не гаснет (Wake Lock;
 *  в Safari с 16.4 работает и в установленном приложении). */
export function FocusFullscreen({ onClose }: { onClose: () => void }) {
  const p = usePomodoro();
  const lock = useRef<WakeLockSentinel | null>(null);

  // Экран не гаснет, пока идёт круг. Блокировка снимается системой при
  // сворачивании — по возвращении просим снова.
  useEffect(() => {
    let alive = true;
    const acquire = async () => {
      try {
        if (!('wakeLock' in navigator) || lock.current || document.visibilityState !== 'visible') return;
        const l = await navigator.wakeLock.request('screen');
        if (!alive) {
          void l.release();
          return;
        }
        lock.current = l;
        l.addEventListener('release', () => {
          if (lock.current === l) lock.current = null;
        });
      } catch {
        /* нет API или отказ — просто гаснет как обычно */
      }
    };
    const release = () => {
      void lock.current?.release();
      lock.current = null;
    };
    if (p.running) void acquire();
    else release();
    const onVis = () => {
      if (document.visibilityState === 'visible' && p.running) void acquire();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVis);
      release();
    };
  }, [p.running]);

  const isWork = p.phase === 'work';
  const color = isWork ? 'var(--focus-accent)' : 'var(--app-success)';
  const frac = p.totalMs > 0 ? 1 - p.remainingMs / p.totalMs : 0;

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col items-center justify-between px-6 pb-12 pt-[calc(env(safe-area-inset-top)+16px)] text-text"
      style={{ background: 'radial-gradient(80% 50% at 50% 0%, oklch(0.26 0.06 290), oklch(0.12 0.01 283) 70%)' }}
      data-testid="focus-fullscreen"
    >
      <div className="flex w-full items-center">
        <button
          type="button"
          aria-label={t('Свернуть')}
          onClick={onClose}
          className={`flex size-11 items-center justify-center rounded-full text-muted active:opacity-60 ${HIT_SLOP_44}`}
        >
          <ChevronDown size={ICON.accent} />
        </button>
      </div>

      <div className="text-center">
        <p className="text-sm font-semibold" style={{ color }}>
          {t(PHASE_LABEL[p.phase])} · {t('Круг {n} из {total}', { n: String(Math.min(p.cycle.done + 1, p.cycle.total)), total: String(p.cycle.total) })}
        </p>
        {p.taskTitle && <p className="mt-1.5 max-w-[80vw] truncate text-base">{p.taskTitle}</p>}
      </div>

      <div className="relative">
        <svg viewBox="0 0 300 300" className="w-[300px] max-w-[80vw]">
          <circle cx="150" cy="150" r={R} fill="none" stroke="oklch(1 0 0 / 0.1)" strokeWidth={STROKE} />
          <circle
            cx="150"
            cy="150"
            r={R}
            fill="none"
            stroke={color}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - frac)}
            transform="rotate(-90 150 150)"
            style={{ transition: p.running ? 'stroke-dashoffset 0.5s linear' : 'none' }}
          />
        </svg>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="text-[72px] font-light tabular-nums tracking-tight" data-testid="fullscreen-clock">
            {formatClock(p.remainingMs)}
          </span>
        </div>
      </div>

      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={p.reset}
            aria-label={t('Сбросить')}
            className="flex size-12 items-center justify-center rounded-full border border-white/15 text-muted active:scale-90"
          >
            <RotateCcw size={ICON.header} />
          </button>
          <button
            type="button"
            onClick={p.running ? p.toggle : () => (p.active ? p.toggle() : p.start())}
            aria-label={p.running ? t('Пауза') : t('Старт')}
            style={{ backgroundImage: 'linear-gradient(150deg, var(--focus-accent-fill), var(--focus-accent-2-fill))' }}
            className="flex size-20 items-center justify-center rounded-full text-white active:scale-90"
          >
            {p.running ? <Pause size={ICON.hero} fill="currentColor" /> : <Play size={ICON.hero} fill="currentColor" className="ml-1" />}
          </button>
          <button
            type="button"
            onClick={p.skip}
            disabled={!p.active}
            aria-label={isWork ? t('Завершить круг') : t('Пропустить перерыв')}
            className="flex size-12 items-center justify-center rounded-full border border-white/15 text-muted active:scale-90 disabled:opacity-40"
          >
            <SkipForward size={ICON.header} />
          </button>
        </div>
        <p className="text-xs text-muted">{t('Экран не гаснет, пока идёт круг')}</p>
      </div>
    </div>
  );
}
