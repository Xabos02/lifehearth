// SyncHub — Durable Object: один на аккаунт синхронизации. Держит живые
// WebSocket-соединения устройств этого аккаунта и, когда одно из них прислало
// правки, говорит остальным «забери». Сам данных не хранит и не видит: обмен
// идёт по-прежнему через /sync/push и /sync/pull, здесь только сигнал.
//
// Зачем. Без сигнала устройство узнавало о чужой правке на очередном опросе —
// раз в минуту, и только пока приложение на экране. Со стороны это выглядело
// как «на телефоне задача есть, на маке нет». Опрос остаётся запасным путём:
// сокет — ускоритель, а не транспорт, и его обрыв ничего не теряет.
//
// Hibernation API: пока сообщений нет, объект спит и ничего не стоит.
// ping/pong отвечает сам рантайм (setWebSocketAutoResponse), не будя объект.
//
// Авторизация — одноразовым тикетом, как в семейной комнате: браузерный
// WebSocket не умеет слать заголовки, а класть токен аккаунта в адрес сокета
// нельзя — адреса оседают в логах. Тикет выдаёт воркер после обычной проверки
// токена, живёт минуту и гаснет после первого использования.

import { DurableObject } from 'cloudflare:workers';

const TICKET_TTL_MS = 60_000;

export class SyncHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Вне Workers (юнит-тесты) этого класса нет — тогда без авто-ответа.
    if (typeof WebSocketRequestResponsePair !== 'undefined' && ctx.setWebSocketAutoResponse) {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Воркер уже проверил токен аккаунта — здесь только выдаём тикет.
    if (url.pathname === '/sync/ticket' && request.method === 'POST') {
      const ticket = crypto.randomUUID();
      const now = Date.now();
      // Тикеты, которыми так и не воспользовались (сеть оборвалась между
      // тикетом и сокетом), не должны копиться: ключей мало, чистим на ходу.
      const stale = await this.ctx.storage.list({ prefix: 'ticket:' });
      const dead = [...stale.entries()].filter(([, exp]) => Number(exp) < now).map(([k]) => k);
      if (dead.length) await this.ctx.storage.delete(dead);
      await this.ctx.storage.put(`ticket:${ticket}`, now + TICKET_TTL_MS);
      return this.json({ ticket });
    }

    if (url.pathname === '/sync/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return this.json({ error: 'expected websocket' }, 426);
      }
      const ticket = url.searchParams.get('ticket') || '';
      const key = `ticket:${ticket}`;
      const exp = ticket ? await this.ctx.storage.get(key) : undefined;
      if (exp !== undefined) await this.ctx.storage.delete(key); // одноразовый
      if (!exp || Number(exp) < Date.now()) return this.json({ error: 'unauthorized' }, 401);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Воркер зовёт после успешной записи в D1. `by` — устройство-автор: ему
    // самому сигнал не нужен, оно эти правки и прислало.
    if (url.pathname === '/sync/notify' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const frame = JSON.stringify({ type: 'changed', by: typeof body?.by === 'string' ? body.by : '' });
      let delivered = 0;
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(frame);
          delivered++;
        } catch {
          /* сокет закрывается */
        }
      }
      return this.json({ ok: true, delivered });
    }

    return this.json({ error: 'not found' }, 404);
  }

  // === WebSocket (Hibernation API) ===
  // От клиента ничего, кроме ping, не ждём — а на ping отвечает рантайм.
  webSocketMessage() {}

  webSocketClose(ws) {
    try {
      ws.close();
    } catch {
      /* уже закрыт */
    }
  }

  webSocketError(ws) {
    try {
      ws.close();
    } catch {
      /* уже закрыт */
    }
  }
}
