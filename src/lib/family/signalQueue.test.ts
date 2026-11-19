import { describe, it, expect } from 'vitest';
import { enqueueSignal, freshSignals, type QueuedSignal } from './signalQueue';

const f = (kind: string, call = 'c1', data: string | null = null) => ({ to: 'mom', call, kind, data });

describe('очередь сигналов звонка, пока сокет переподключается', () => {
  it('маршруты копятся все, остальное — последнее слово того же звонка, по порядку', () => {
    let q: QueuedSignal[] = [];
    q = enqueueSignal(q, f('offer', 'c1', 'o1'), 0);
    q = enqueueSignal(q, f('ice', 'c1', 'i1'), 1);
    q = enqueueSignal(q, f('ice', 'c1', 'i2'), 2);
    q = enqueueSignal(q, f('offer', 'c1', 'o2'), 3); // повтор приглашения заменяет прежнее
    q = enqueueSignal(q, f('offer', 'c2', 'x'), 4); // другой звонок — свой
    expect(freshSignals(q, 5).map((s) => `${s.kind}:${s.data}`)).toEqual(['ice:i1', 'ice:i2', 'offer:o2', 'offer:x']);
  });

  it('старше 15 с не уходит: звонок к тому времени соединился или кончился', () => {
    let q: QueuedSignal[] = [];
    q = enqueueSignal(q, f('answer', 'c1', 'a'), 0);
    q = enqueueSignal(q, f('ice', 'c1', 'i'), 10_000);
    expect(freshSignals(q, 16_000).map((s) => s.kind)).toEqual(['ice']);
  });

  it('потолок очереди — последние 100', () => {
    let q: QueuedSignal[] = [];
    for (let i = 0; i < 150; i++) q = enqueueSignal(q, f('ice', 'c1', String(i)), i);
    const out = freshSignals(q, 150);
    expect(out).toHaveLength(100);
    expect(out[0].data).toBe('50');
  });
});
