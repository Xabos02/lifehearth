import { createContext, useContext } from 'react';
import { t } from '../../lib/i18n';

// Контекст, хук и форматтеры помодоро вынесены из PomodoroProvider.tsx:
// файл с компонентом должен экспортировать только компоненты,
// иначе ломается Fast Refresh (react-refresh/only-export-components).

export type Phase = 'work' | 'break' | 'long';
export type SoundType = 'none' | 'white' | 'pink' | 'brown' | 'rain';

export interface PomodoroCtx {
  phase: Phase;
  running: boolean;
  remainingMs: number;
  totalMs: number;
  taskId: string | null;
  taskTitle: string | null;
  completedToday: number;
  focusMinToday: number;
  workMin: number;
  breakMin: number;
  longMin: number;
  sound: SoundType;
  active: boolean; // идёт сессия (не дефолтное простаивание)
  start: (taskId?: string | null, taskTitle?: string | null) => void;
  toggle: () => void;
  reset: () => void;
  skip: () => void;
  setDurations: (workMin: number, breakMin: number) => void;
  setWorkMin: (workMin: number) => void;
  setBreakMin: (breakMin: number) => void;
  setLongMin: (longMin: number) => void;
  setTask: (taskId: string | null, taskTitle: string | null) => void;
  setSound: (sound: SoundType) => void;
}

// Два контекста, а не один, — из-за цены тика.
//
// Пока таймер идёт, оставшееся время меняется дважды в секунду. Значение
// контекста при этом пересобиралось целиком, и вместе с ним перерисовывался
// КАЖДЫЙ, кто подписан, — включая форму задачи и кнопку «+», которым от
// таймера нужны только действия. Владелец это заметил как «дёргается экран
// приложения во время письма продолжительного»: он печатал длинный текст, а
// шёл сеанс фокуса, и форма под его пальцами пересобиралась каждые полсекунды.
//
// Поэтому тикающее живёт отдельно: подписался на время — перерисовываешься по
// тику (это честно, ты его показываешь); подписался на действия — не
// перерисовываешься вовсе.
export type PomodoroActions = Omit<PomodoroCtx, 'remainingMs'>;

export const Ctx = createContext<PomodoroActions | null>(null);
/** Только оставшееся время. Меняется дважды в секунду. */
export const TimeCtx = createContext<number>(0);

/** Всё вместе — для тех, кто ПОКАЗЫВАЕТ время (таймер, экран «Фокус»). */
export function usePomodoro(): PomodoroCtx {
  const c = useContext(Ctx);
  const remainingMs = useContext(TimeCtx);
  if (!c) throw new Error('usePomodoro must be used within PomodoroProvider');
  return { ...c, remainingMs };
}

/** Действия и редкие поля, без тикающего времени.
 *
 *  Для тех, кому таймер нужен как кнопка, а не как часы: форма задачи, «+».
 *  Подписка отсюда не даёт ни одной лишней перерисовки за сеанс. */
export function usePomodoroActions(): PomodoroActions {
  const c = useContext(Ctx);
  if (!c) throw new Error('usePomodoroActions must be used within PomodoroProvider');
  return c;
}

/** «25:00» из миллисекунд. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** «1 ч 25 мин» / «25 мин» из минут — для статистики фокуса. */
export function formatFocusTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}\u00A0${t('мин')}`;
  return m === 0 ? `${h}\u00A0${t('ч')}` : `${h}\u00A0${t('ч')} ${m}\u00A0${t('мин')}`;
}
