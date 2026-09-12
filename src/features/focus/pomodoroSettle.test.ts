import { describe, expect, it } from 'vitest';
import { cycleDots, nextAfterWork, settle, type PomodoroState } from './pomodoroSettle';

const base: PomodoroState = {
  phase: 'work',
  running: true,
  endsAt: 1_000_000,
  remainingMs: 0,
  workCount: 0,
  completedToday: 0,
  focusMinToday: 0,
  date: '2026-09-12',
  workMin: 25,
  breakMin: 5,
  longMin: 15,
  longAfter: 4,
};
const MIN = 60_000;

describe('settle — докрутка таймера после фона', () => {
  it('не трогает таймер, который не шёл или дошёл только что', () => {
    const idle = { ...base, running: false, endsAt: null };
    expect(settle(idle, 5_000_000, base.date)).toBe(idle);
    // 10 секунд после конца — это «только что», обслуживает обычный тик со звуком.
    expect(settle(base, base.endsAt! + 10_000, base.date)).toBe(base);
  });

  it('рабочий круг, кончившийся в фоне, засчитан, перерыв идёт с настоящим остатком', () => {
    const now = base.endsAt! + 2 * MIN; // две минуты пятиминутного перерыва прошли
    const s = settle(base, now, base.date);
    expect(s.phase).toBe('break');
    expect(s.running).toBe(true);
    expect(s.workCount).toBe(1);
    expect(s.completedToday).toBe(1);
    expect(s.focusMinToday).toBe(25);
    expect(s.endsAt).toBe(base.endsAt! + 5 * MIN);
    expect(s.remainingMs).toBe(3 * MIN);
  });

  it('если и перерыв прошёл — таймер ждёт в начале следующего круга, без «перерыва с этой секунды»', () => {
    const now = base.endsAt! + 60 * MIN;
    const s = settle(base, now, base.date);
    expect(s.phase).toBe('work');
    expect(s.running).toBe(false);
    expect(s.endsAt).toBeNull();
    expect(s.remainingMs).toBe(25 * MIN);
    expect(s.completedToday).toBe(1);
  });

  it('четвёртый круг ведёт в длинный перерыв по longAfter', () => {
    const s = settle({ ...base, workCount: 3 }, base.endsAt! + 2 * MIN, base.date);
    expect(s.phase).toBe('long');
    expect(s.endsAt).toBe(base.endsAt! + 15 * MIN);
    const s2 = settle({ ...base, workCount: 1, longAfter: 2 }, base.endsAt! + 2 * MIN, base.date);
    expect(s2.phase).toBe('long');
  });

  it('перерыв, кончившийся в фоне, просто останавливает таймер — круг не прибавляется', () => {
    const s = settle({ ...base, phase: 'break', workCount: 1, completedToday: 1 }, base.endsAt! + 10 * MIN, base.date);
    expect(s.phase).toBe('work');
    expect(s.running).toBe(false);
    expect(s.workCount).toBe(1);
    expect(s.completedToday).toBe(1);
  });

  it('круг, дошедший до конца уже в новый день, открывает счётчики дня заново', () => {
    const s = settle({ ...base, completedToday: 6, focusMinToday: 150 }, base.endsAt! + 2 * MIN, '2026-09-13');
    expect(s.completedToday).toBe(1);
    expect(s.focusMinToday).toBe(25);
    expect(s.date).toBe('2026-09-13');
  });
});

describe('nextAfterWork / cycleDots', () => {
  it('длинный перерыв — каждый longAfter-й', () => {
    expect(nextAfterWork(1, 4)).toBe('break');
    expect(nextAfterWork(4, 4)).toBe('long');
    expect(nextAfterWork(8, 4)).toBe('long');
    expect(nextAfterWork(2, 2)).toBe('long');
    expect(nextAfterWork(1, 1)).toBe('long');
  });

  it('точки: в работе идёт круг done+1, в перерыве done позади, в длинном — весь ряд', () => {
    expect(cycleDots('work', 0, 4)).toEqual({ done: 0, total: 4 });
    expect(cycleDots('work', 1, 4)).toEqual({ done: 1, total: 4 });
    expect(cycleDots('break', 1, 4)).toEqual({ done: 1, total: 4 });
    expect(cycleDots('long', 4, 4)).toEqual({ done: 4, total: 4 });
    // После длинного перерыва цикл начинается заново.
    expect(cycleDots('work', 4, 4)).toEqual({ done: 0, total: 4 });
    expect(cycleDots('long', 8, 4)).toEqual({ done: 4, total: 4 });
  });
});
