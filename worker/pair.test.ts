// Встреча двух устройств: открыть её и положить конверт можно один раз
// (аудит 1.64.0, S7).
//
// Как это ломалось. /pair/offer и /pair/seal писали INSERT OR REPLACE без
// проверки. Тот, кто знал код встречи, мог переоткрыть её поверх настоящей
// (pubB сбрасывался, и он отвечал первым своим ключом) или подменить конверт:
// второй телефон получал чужой шифротекст и ошибку, а первый показывал
// «Устройство подключено».

import { describe, expect, it, vi } from 'vitest';
import { d1, sqliteDb } from './d1Sqlite';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const worker = (await import('./src/index.js')).default as {
  fetch: (r: Request, e: unknown, c: unknown) => Promise<Response>;
};

const PAIR = 'pairABCDEFGH12345678';

function server() {
  const env = { DB: d1(sqliteDb()) };
  const call = async (path: string, body?: unknown) => {
    const res = await worker.fetch(
      new Request(`https://w.test${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
      { waitUntil() {} },
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  return { call };
}

describe('сопряжение: встреча открывается и запечатывается один раз (S7)', () => {
  it('повторный /pair/offer с тем же кодом — 409, ответ второго устройства не сброшен', async () => {
    const s = server();
    expect((await s.call('/pair/offer', { pairId: PAIR, pubA: 'PUB_A' })).status).toBe(200);
    expect((await s.call('/pair/answer', { pairId: PAIR, pubB: 'PUB_B' })).status).toBe(200);

    expect((await s.call('/pair/offer', { pairId: PAIR, pubA: 'PUB_ATT' })).status).toBe(409);
    expect((await s.call(`/pair/state?pairId=${PAIR}`)).data).toEqual({ pubB: 'PUB_B', sealed: false });
    // Второй ответ по-прежнему не принимается — встать на место B нельзя.
    expect((await s.call('/pair/answer', { pairId: PAIR, pubB: 'PUB_ATT' })).status).toBe(409);
  });

  it('конверт до ответа второго устройства — 409', async () => {
    const s = server();
    await s.call('/pair/offer', { pairId: PAIR, pubA: 'PUB_A' });
    expect((await s.call('/pair/seal', { pairId: PAIR, sealed: 'ATTACKER' })).status).toBe(409);
    expect((await s.call(`/pair/state?pairId=${PAIR}`)).data).toEqual({ pubB: null, sealed: false });
  });

  it('второй конверт — 409, второе устройство забирает первый, настоящий', async () => {
    const s = server();
    await s.call('/pair/offer', { pairId: PAIR, pubA: 'PUB_A' });
    await s.call('/pair/answer', { pairId: PAIR, pubB: 'PUB_B' });
    expect((await s.call('/pair/seal', { pairId: PAIR, sealed: 'ENV' })).status).toBe(200);

    expect((await s.call('/pair/seal', { pairId: PAIR, sealed: 'ATTACKER' })).status).toBe(409);
    expect((await s.call(`/pair/claim?pairId=${PAIR}`)).data).toEqual({ sealed: 'ENV' });
  });
});
