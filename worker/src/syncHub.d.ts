// Типы для тестов, которые поднимают Durable Object вне Workers — по образцу
// familyRoom.d.ts: сам файл остаётся JavaScript, деплоится через wrangler.
export declare class SyncHub {
  constructor(ctx: unknown, env: unknown);
  fetch(request: Request): Promise<Response>;
}
