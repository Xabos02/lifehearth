import { useLocation, useNavigate } from 'react-router';
import {
  GPause as Pause,
  GPlay as Play,
  GRepeat as RotateCcw,
} from '../../components/ui/glyphs';
import { formatClock, usePomodoro } from './pomodoro';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

/** Полоска-таймер над таб-баром, пока идёт помодоро. Тап — открыть «Фокус». */
export function MiniTimer() {
  const p = usePomodoro();
  const nav = useNavigate();
  const { pathname } = useLocation();

  // Крестика «Убрать таймер» здесь больше нет. Он прятал плашку только
  // локально, а плавающая «+» держит зазор по p.active — и после «Убрать»
  // кнопка до конца фазы висела на 48px над пустотой. Плашка 53px не мешает,
  // а вернуть её после крестика было нельзя иначе как через «Ещё → Фокус».
  if (!p.active) return null;
  if (pathname === '/more/focus') return null; // на самой странице не дублируем
  if (/^\/notes\/.+/.test(pathname)) return null; // там таб-бара нет

  const color = p.phase === 'work' ? 'var(--focus-accent)' : 'var(--app-success)';
  // Бокс 36px вместо прежних 26: три кнопки идут подряд через gap-2, и
  // невидимая зона 44 им не подходит — соседние зоны перекрылись бы (ограничение
  // в hitSlop.ts: не ближе 11px друг к другу). Поэтому растёт сама кнопка:
  // 36 + 8 зазора = шаг 44, попадание пальцем без промаха по соседу.
  const iconBtn = 'flex size-9 shrink-0 items-center justify-center rounded-full text-muted active:opacity-60';
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t('Открыть Фокус')}
      onClick={() => nav('/more/focus')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          nav('/more/focus');
        }
      }}
      className="z-30 flex shrink-0 cursor-pointer items-center gap-2 border-t border-hairline bg-elevated px-4 py-2 active:opacity-80"
    >
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="shrink-0 text-sm font-semibold tabular-nums" style={{ color }}>
        {formatClock(p.remainingMs)}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-muted">
        {p.phase === 'work' ? p.taskTitle || t('Фокус') : p.phase === 'long' ? t('Длинный перерыв') : t('Перерыв')}
      </span>
      <button
        type="button"
        aria-label={p.running ? t('Пауза') : t('Продолжить')}
        onClick={(e) => {
          e.stopPropagation();
          p.toggle();
        }}
        className={iconBtn}
      >
        {p.running ? <Pause size={ICON.base} /> : <Play size={ICON.base} />}
      </button>
      <button
        type="button"
        aria-label={t('Сбросить помодоро')}
        onClick={(e) => {
          e.stopPropagation();
          p.reset();
        }}
        className={iconBtn}
      >
        <RotateCcw size={ICON.base} />
      </button>
    </div>
  );
}
