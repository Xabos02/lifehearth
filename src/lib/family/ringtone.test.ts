import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/db', () => ({ db: { settings: { get: async () => undefined } } }));

// Подставной WebAudio: записываем, какие тоны и когда запланированы.
const oscs: { freq: number; start: number; stop: number; stopped: boolean }[] = [];
class FakeParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
}
class FakeCtx {
  state = 'running';
  currentTime = 10;
  destination = {};
  resume = async () => {};
  createGain() {
    return { gain: new FakeParam(), connect() {}, disconnect() {} };
  }
  createOscillator() {
    const rec = { freq: 0, start: -1, stop: -1, stopped: false };
    oscs.push(rec);
    return {
      type: 'sine',
      frequency: {
        set value(v: number) {
          rec.freq = v;
        },
      },
      connect() {},
      start(t: number) {
        rec.start = t;
      },
      stop(t?: number) {
        if (t === undefined) rec.stopped = true;
        else rec.stop = t;
      },
    };
  }
}

describe('гудки звонящему', () => {
  beforeEach(() => {
    oscs.length = 0;
    vi.stubGlobal('AudioContext', FakeCtx);
  });

  it('425 Гц, 1 с звук / 4 с пауза — на весь дозвон, и стоп глушит всё', async () => {
    const { startRingback, stopRingback } = await import('./ringtone');
    startRingback();
    expect(oscs.length).toBeGreaterThanOrEqual(10); // 45 с дозвона ÷ 5 с
    expect(oscs.every((o) => o.freq === 425)).toBe(true);
    for (let i = 0; i < oscs.length; i++) {
      expect(oscs[i].start).toBeCloseTo(10.05 + i * 5, 5);
      expect(oscs[i].stop - oscs[i].start).toBeCloseTo(1, 5);
    }
    // «Звонит» приходит повторами — повторный старт не перезапускает ритм.
    const n = oscs.length;
    startRingback();
    expect(oscs.length).toBe(n);
    stopRingback();
    expect(oscs.every((o) => o.stopped)).toBe(true);
  });
});
