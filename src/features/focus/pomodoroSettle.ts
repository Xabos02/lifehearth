import type { Phase } from './pomodoro';

/** Состояние таймера, как оно лежит в localStorage. Общее с провайдером. */
export interface PomodoroState {
  phase: Phase;
  running: boolean;
  endsAt: number | null;
  remainingMs: number;
  workCount: number;
  completedToday: number;
  focusMinToday: number;
  date: string;
  workMin: number;
  breakMin: number;
  longMin: number;
  longAfter: number;
}

export function phaseMs(phase: Phase, s: Pick<PomodoroState, 'workMin' | 'breakMin' | 'longMin'>): number {
  if (phase === 'work') return s.workMin * 60_000;
  if (phase === 'long') return s.longMin * 60_000;
  return s.breakMin * 60_000;
}

/** Фаза, которая идёт после рабочей: каждая longAfter-я — длинный перерыв. */
export function nextAfterWork(workCount: number, longAfter: number): Phase {
  return workCount % Math.max(1, longAfter) === 0 ? 'long' : 'break';
}

/** Сколько кругов текущего цикла сделано и сколько всего — для точек под
 *  таймером. В рабочей фазе идёт круг номер done+1; в перерыве все done уже
 *  позади, в длинном перерыве закрашен весь ряд. */
export function cycleDots(phase: Phase, workCount: number, longAfter: number): { done: number; total: number } {
  const total = Math.max(1, longAfter);
  const done = phase === 'work' ? workCount % total : ((workCount - 1) % total) + 1;
  return { done, total };
}

/** Дальше этого таймер считается «просроченным в фоне», а не «только что
 *  дошёл». Двадцать секунд, не минута: кто вернулся позже — уже видел пуш, и
 *  сигнал с уведомлением в лицо ему не нужен. */
export const STALE_MS = 20_000;

/** Довести таймер до настоящего времени после того, как приложение лежало
 *  свёрнутым или закрытым.
 *
 *  Раньше по возвращении вызывался обычный переход фазы: сигнал, уведомление,
 *  и перерыв начинался с этой секунды — даже если рабочий круг закончился час
 *  назад, а фоновый пуш об этом давно пришёл. Человек открывал приложение утром
 *  и получал «Фокус завершён» за вчера.
 *
 *  Здесь фазы докручиваются по реальному времени и без звука: рабочий круг,
 *  который дошёл до конца, засчитывается; перерыв после него либо ещё идёт (и
 *  тогда таймер встаёт на его настоящий остаток), либо тоже прошёл — и таймер
 *  спокойно ждёт в начале следующего круга. Ничего не трогает, если таймер не
 *  шёл или дошёл только что (STALE_MS): такое обслуживает обычный тик. */
export function settle<T extends PomodoroState>(s: T, now: number, today: string): T {
  if (!s.running || s.endsAt == null || now - s.endsAt < STALE_MS) return s;
  let cur: T = { ...s };
  // Пока фаза кончилась в прошлом — переходим дальше без побочных эффектов.
  while (cur.running && cur.endsAt != null && cur.endsAt <= now) {
    if (cur.phase === 'work') {
      const workCount = cur.workCount + 1;
      const next = nextAfterWork(workCount, cur.longAfter);
      const sameDay = cur.date === today;
      cur = {
        ...cur,
        phase: next,
        workCount,
        completedToday: (sameDay ? cur.completedToday : 0) + 1,
        focusMinToday: (sameDay ? cur.focusMinToday : 0) + cur.workMin,
        date: today,
        endsAt: cur.endsAt + phaseMs(next, cur),
        remainingMs: phaseMs(next, cur),
      };
    } else {
      cur = { ...cur, phase: 'work', running: false, endsAt: null, remainingMs: cur.workMin * 60_000 };
    }
  }
  if (cur.running && cur.endsAt != null) cur = { ...cur, remainingMs: cur.endsAt - now };
  return cur;
}
