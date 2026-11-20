import { useEffect, useRef } from 'react';
import { GFaCompress, GFaForwardStep, GFaPause, GFaPlay, GFaRotateLeft, GFaSun } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { t } from '../../lib/i18n';
import { formatClock, usePomodoro } from './pomodoro';

const PHASE_LABEL = { work: 'Фокус', break: 'Перерыв', long: 'Длинный перерыв' } as const;

/** Режим на весь экран: только время, полоса прогресса и кнопки на тёмном фоне — как
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
  const color = isWork ? 'var(--lh-accent)' : 'var(--app-success)';
  const frac = p.totalMs > 0 ? Math.min(1, Math.max(0, 1 - p.remainingMs / p.totalMs)) : 0;
  const elapsedMs = Math.max(0, p.totalMs - p.remainingMs);

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-lh-bg px-2 pb-[calc(env(safe-area-inset-bottom)+40px)] pt-[env(safe-area-inset-top)] text-lh-text-primary"
      data-testid="focus-fullscreen"
    >
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 items-center gap-2 px-2 text-base text-lh-accent active:opacity-60"
        >
          <GFaCompress size={ICON.action} /> {t('Свернуть')}
        </button>
        <span className="mr-2 flex h-8 items-center gap-2 rounded-full border border-lh-border bg-lh-surface px-3 text-xs text-lh-text-secondary">
          <span className="size-1.5 rounded-full" style={{ background: color }} />
          {t(PHASE_LABEL[p.phase])}
        </span>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <p className="text-xs uppercase tabular-nums tracking-[.08em] text-lh-text-secondary">
          {t('Круг {n} из {total}', { n: String(Math.min(p.cycle.done + 1, p.cycle.total)), total: String(p.cycle.total) })}
        </p>
        <span
          className="mt-4 text-[72px] font-light leading-none tabular-nums tracking-tight"
          data-testid="fullscreen-clock"
        >
          {formatClock(p.remainingMs)}
        </span>
        <div
          className="mt-8 h-[3px] w-[260px] max-w-full overflow-hidden rounded-full bg-lh-surface-2"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(frac * 100)}
          aria-label={t('Прогресс круга')}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${frac * 100}%`, background: color, transition: p.running ? 'width 0.5s linear' : 'none' }}
          />
        </div>
        <div className="mt-3 flex w-[260px] max-w-full justify-between text-xs tabular-nums text-lh-text-secondary">
          <span>{t('прошло {time}', { time: formatClock(elapsedMs) })}</span>
          <span>{t('из {time}', { time: formatClock(p.totalMs) })}</span>
        </div>
        {p.taskTitle && <p className="mt-10 line-clamp-2 max-w-[300px] text-base leading-snug">{p.taskTitle}</p>}
      </div>

      <div className="flex flex-col items-center">
        <div className="flex items-center gap-8">
          <button
            type="button"
            onClick={p.reset}
            aria-label={t('Сбросить')}
            className="flex size-14 items-center justify-center rounded-full border border-lh-border bg-lh-surface text-lh-text-primary active:scale-90"
          >
            <GFaRotateLeft size={ICON.base} />
          </button>
          <button
            type="button"
            onClick={p.running ? p.toggle : () => (p.active ? p.toggle() : p.start())}
            aria-label={p.running ? t('Пауза') : t('Старт')}
            className="flex size-20 items-center justify-center rounded-full bg-lh-accent text-lh-bg active:scale-90"
          >
            {p.running ? <GFaPause size={ICON.display} /> : <GFaPlay size={ICON.display} className="ml-1" />}
          </button>
          <button
            type="button"
            onClick={p.skip}
            disabled={!p.active}
            aria-label={isWork ? t('Завершить круг') : t('Пропустить перерыв')}
            className="flex size-14 items-center justify-center rounded-full border border-lh-border bg-lh-surface text-lh-text-primary active:scale-90 disabled:opacity-40"
          >
            <GFaForwardStep size={ICON.base} />
          </button>
        </div>
        <p className="mt-8 flex items-center gap-2 text-xs text-lh-text-secondary">
          <GFaSun size={ICON.inline} /> {t('Экран не гаснет, пока идёт круг')}
        </p>
      </div>
    </div>
  );
}
