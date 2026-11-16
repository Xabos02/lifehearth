import { describe, expect, it } from 'vitest';
import type { Task } from '../db/types';
import { projectProgress } from './progress';

const task = (over: Partial<Task> = {}): Task =>
  ({ id: Math.random().toString(36), completedAt: null, recurrence: null, ...over }) as Task;
const done = (over: Partial<Task> = {}) => task({ completedAt: '2026-11-16T10:00:00Z', ...over });
const daily = { type: 'daily', interval: 1 } as const;

describe('projectProgress', () => {
  it('доля сделанных разовых задач', () => {
    const active = [task(), task(), task()];
    expect(projectProgress(active, Array.from({ length: 7 }, () => done()))).toBe(70);
  });

  it('отметки повтора не раздувают процент', () => {
    // «Дом»: живая копия ежедневной задачи + 2 разовые; выполнено 20 повторов и 1 разовая.
    const active = [task({ recurrence: daily }), task(), task()];
    const finished = [done(), ...Array.from({ length: 20 }, () => done({ recurrence: daily }))];
    expect(projectProgress(active, finished)).toBe(33);
  });

  it('спящая задача ручного повтора не считается', () => {
    const sleeping = done({ recurrence: { type: 'manual' } });
    expect(projectProgress([task(), sleeping], [done()])).toBe(50);
  });

  it('разовых задач нет — полоски нет', () => {
    expect(projectProgress([task({ recurrence: daily })], [done({ recurrence: daily })])).toBeNull();
    expect(projectProgress([], [])).toBeNull();
  });

  it('округление не обещает 100% и 0% раньше времени', () => {
    const many = (n: number, f: () => Task) => Array.from({ length: n }, f);
    expect(projectProgress([task()], many(199, () => done()))).toBe(99);
    expect(projectProgress(many(200, () => task()), [done()])).toBe(1);
  });

  it('ничего не сделано — 0, всё сделано — 100', () => {
    expect(projectProgress([task()], [])).toBe(0);
    expect(projectProgress([], [done()])).toBe(100);
  });
});
