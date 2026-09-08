import { describe, expect, it } from 'vitest';
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, reconnectDelay } from './reconnectDelay';

describe('пауза между попытками подключиться к семейному чату', () => {
  it('первая попытка — прежние три секунды: моргнувшая сеть чинится так же быстро', () => {
    expect(reconnectDelay(0, 0)).toBe(RECONNECT_BASE_MS);
  });

  it('каждая следующая вдвое дольше', () => {
    expect(reconnectDelay(1, 0)).toBe(6000);
    expect(reconnectDelay(2, 0)).toBe(12_000);
    expect(reconnectDelay(3, 0)).toBe(24_000);
  });

  it('дальше минуты не растёт — иначе вернувшуюся связь ждали бы часами', () => {
    expect(reconnectDelay(10, 0)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelay(1000, 0)).toBe(RECONNECT_MAX_MS);
  });

  it('разброс только удлиняет паузу и не больше чем на четверть', () => {
    expect(reconnectDelay(0, 1)).toBe(3750);
    expect(reconnectDelay(10, 1)).toBe(75_000);
    for (const a of [0, 1, 5, 20]) {
      const d = reconnectDelay(a, Math.random());
      const base = Math.min(RECONNECT_BASE_MS * 2 ** a, RECONNECT_MAX_MS);
      expect(d).toBeGreaterThanOrEqual(base);
      expect(d).toBeLessThanOrEqual(base * 1.25);
    }
  });

  it('сутки непроходящего отказа стоят тысячи запросов, а не десятки тысяч', () => {
    // Три запроса на попытку: задача, тикет, сокет. Считаем сутки без разброса.
    let t = 0;
    let attempt = 0;
    while (t < 24 * 3600_000) {
      t += reconnectDelay(attempt, 0);
      attempt += 1;
    }
    expect(attempt * 3).toBeLessThan(5000); // было бы 86 400
  });
});
