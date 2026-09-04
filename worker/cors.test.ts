// CORS воркера — то, во что упирается браузер ДО всякой бизнес-логики.
//
// Зачем отдельным файлом: familyRoom.test.ts дёргает Durable Object напрямую,
// минуя worker/src/index.js, а именно там живут заголовки. Из-за этого целый
// класс поломок был невидим: роут есть, обработчик правильный, тесты зелёные —
// а браузер до воркера не доходит вообще.
//
// Так и случилось с исключением участника. Клиент шлёт X-Family-Owner, это
// непростой заголовок, браузер делает preflight OPTIONS, воркер отвечал
// списком без него — и fetch падал TypeError «Failed to fetch», а человек
// видел «не удалось исключить, проверьте связь» и думал, что дело в интернете.

import { describe, expect, it, vi } from 'vitest';

// index.js реэкспортирует FamilyRoom, а тот тянет модуль, которого вне Workers
// не существует. Сам Durable Object здесь не нужен — проверяются заголовки в
// default.fetch, — но без заглушки файл просто не загрузится.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const worker = await import('./src/index.js');

/** Заголовки, которые клиент реально ставит. Список собран из кода клиента,
 *  а не выдуман: разойдись он с правдой — тест перестанет что-либо значить. */
const CLIENT_HEADERS = [
  'Content-Type', // везде, где есть тело
  'Authorization', // Bearer familyToken / accountToken
  'X-Account', // синхронизация: src/lib/sync.ts
  'X-Family-Owner', // исключение участника: src/lib/family/familyKeys.ts
];

const ORIGIN = 'https://xabos02.github.io';

async function preflight(path: string) {
  return worker.default.fetch(
    new Request(`https://life-hub-push.workers.dev${path}`, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-family-owner',
      },
    }),
    { ALLOW_ORIGIN: ORIGIN },
    { waitUntil: () => {} },
  );
}

describe('CORS', () => {
  it('preflight пропускает все заголовки, которые ставит клиент', async () => {
    const res = await preflight('/family/remove');
    expect(res.status).toBe(204);
    const allowed = (res.headers.get('Access-Control-Allow-Headers') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase());
    for (const h of CLIENT_HEADERS) {
      expect(allowed, `браузер не пропустит ${h} — запрос не долетит до воркера`).toContain(
        h.toLowerCase(),
      );
    }
  });

  it('preflight отвечает без авторизации', async () => {
    // Браузер шлёт OPTIONS сам и никаких токенов в него не кладёт. Потребуй
    // воркер здесь Authorization — не работал бы ни один POST с фронта.
    const res = await preflight('/family/remove');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('POST разрешён — иначе preflight отклонит метод', async () => {
    const res = await preflight('/sync/push');
    const methods = (res.headers.get('Access-Control-Allow-Methods') ?? '').toUpperCase();
    expect(methods).toContain('POST');
    expect(methods).toContain('GET');
  });
});
