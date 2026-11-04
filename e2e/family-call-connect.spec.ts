import { expect } from '@playwright/test';
import type { Browser, Page, WebSocketRoute } from '@playwright/test';
import { openApp, test, WORKER_MATCH, OPEN_METEO_MATCH } from './fixtures';

// Настоящий звонок между двумя «телефонами» — от тапа «позвонить» до звука.
//
// Соседний family-call.spec.ts проверяет кнопки и экраны; само соединение не
// проверял никто. А 03.11.2026 мама позвонила, Влад ответил — и связь так и не
// встала. Здесь два отдельных профиля браузера с поддельным микрофоном и
// настоящим WebRTC, между ними подставной сервер семьи: он пересылает сигналы
// звонка, как воркер (адресату по memberId, автора ставит сам), и по просьбе
// теста теряет, дублирует или придерживает их — ровно то, что делает с ними
// мобильная сеть.

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

interface Frame {
  from: string | null;
  to: string | null;
  call: string | null;
  kind: string | null;
  data: string | null;
}

/** Подставной сервер семьи: сокеты обоих телефонов и пересылка сигналов. */
function makeRelay() {
  const members = new Map<WebSocketRoute, string | null>();
  const log: Frame[] = [];
  // Что сделать с сигналом: пропустить (1), потерять (0) или доставить
  // несколько копий разом (n) — так приходит пачка, накопленная, пока
  // телефон спал.
  let copies: (f: Frame) => number = () => 1;
  const online = () => [...members.values()].filter(Boolean) as string[];
  const presence = () => {
    const f = JSON.stringify({ type: 'presence', online: online(), lastSeen: {} });
    for (const s of members.keys()) s.send(f);
  };
  const handler = (ws: WebSocketRoute) => {
    members.set(ws, null);
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === 'ping') return ws.send('{"t":"pong"}');
      if (m.type === 'hello') {
        members.set(ws, m.memberId ?? null);
        ws.send(JSON.stringify({ type: 'backfill', items: [], hasMore: false, nextSince: 0 }));
        ws.send(JSON.stringify({ type: 'ready', headSeq: 0, online: online(), reads: [], lastSeen: {} }));
        presence();
        return;
      }
      if (m.type === 'send') {
        return ws.send(JSON.stringify({ type: 'ack', clientMsgId: m.clientMsgId ?? null, itemId: m.clientMsgId, seq: 1 }));
      }
      if (m.type !== 'signal') return;
      const f: Frame = { from: members.get(ws) ?? null, to: m.to ?? null, call: m.call ?? null, kind: m.kind ?? null, data: m.data ?? null };
      log.push(f);
      const n = copies(f);
      for (const [sock, id] of members) {
        if (sock === ws || id !== f.to) continue;
        for (let i = 0; i < n; i++) sock.send(JSON.stringify({ type: 'signal', ...f }));
      }
    });
    ws.onClose(() => {
      members.delete(ws);
      presence();
    });
  };
  return {
    handler,
    log,
    setCopies(fn: (f: Frame) => number) {
      copies = fn;
    },
    kinds: (from: string) => log.filter((f) => f.from === from).map((f) => f.kind),
  };
}

type Relay = ReturnType<typeof makeRelay>;

/** Телефон участника: свой профиль браузера, общий сервер и общий ключ семьи. */
async function phone(
  browser: Browser,
  relay: Relay,
  rawKey: string,
  self: { id: string; name: string },
  peer: { id: string; name: string },
  init?: () => void,
): Promise<Page> {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  await ctx.route(OPEN_METEO_MATCH, (r) => r.abort('failed'));
  await ctx.route(WORKER_MATCH, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/family/challenge')) return route.fulfill({ json: { challenge: null } });
    if (path.endsWith('/family/ticket')) return route.fulfill({ json: { ticket: 't', bound: false } });
    // Ретранслятора в тесте нет: оба телефона на одной машине, им хватает
    // прямого пути. STUN — заведомо молчащий локальный адрес, чтобы тест не
    // ходил наружу.
    if (path.endsWith('/family/turn')) return route.fulfill({ json: { iceServers: [{ urls: 'stun:127.0.0.1:3478' }] } });
    return route.fulfill({ json: { ok: true } });
  });
  await ctx.routeWebSocket(/\/family\/ws/, relay.handler);
  const page = await ctx.newPage();
  if (init) await page.addInitScript(init);
  await openApp(page, '/more/family');
  await page.evaluate(
    async ({ rawKey, self, peer }) => {
      const { db } = await import('/src/db/db.ts');
      const { importKeyRaw } = await import('/src/lib/crypto.ts');
      const key = await importKeyRaw(rawKey);
      const now = new Date().toISOString();
      await db.family.put({
        id: 'f1', familyId: 'f1', familyToken: 't', familyKey: key, familyName: 'Мы',
        selfMemberId: self.id, lastSeq: 0, lastReadSeq: 0, enabled: true, joinedAt: now,
        keyEpoch: 0, keyRing: { '0': key },
      } as never);
      const mk = (m: { id: string; name: string }) => ({
        id: m.id, familyId: 'f1', seq: 1, displayName: m.name, color: '#5b7cfa',
        joinedAt: now, leftAt: null, removedAt: null,
      });
      await db.familyMembers.bulkPut([mk(self), mk(peer)] as never[]);
    },
    { rawKey, self, peer },
  );
  await page.goto('/more/family?g=f1');
  await expect(page.getByRole('heading', { name: 'Мы' })).toBeVisible();
  return page;
}

const MOM = { id: 'mom', name: 'Мама' };
const VLAD = { id: 'vlad', name: 'Влад' };

async function familyKey(browser: Browser): Promise<string> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await ctx.route(WORKER_MATCH, (r) => r.abort('failed'));
  await page.goto('/');
  const raw = await page.evaluate(async () => {
    const { generateKey, exportKeyRaw } = await import('/src/lib/crypto.ts');
    return exportKeyRaw(await generateKey());
  });
  await ctx.close();
  return raw;
}

/** Оба на связи и звук идёт: у каждого растёт счётчик принятых аудиопакетов. */
async function expectTalking(...pages: Page[]) {
  for (const p of pages) await expect(p.getByText('На связи')).toBeVisible({ timeout: 15_000 });
  for (const p of pages) {
    await expect
      .poll(
        () =>
          p.evaluate(async () => {
            const { callManager } = await import('/src/lib/family/familyCall.ts');
            const pc = (callManager as unknown as { pc: RTCPeerConnection | null }).pc;
            let n = 0;
            (await pc?.getStats())?.forEach((s: RTCStats & { kind?: string; packetsReceived?: number }) => {
              if (s.type === 'inbound-rtp' && s.kind === 'audio') n = s.packetsReceived ?? 0;
            });
            return n;
          }),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
  }
}

async function snapshot(p: Page) {
  return p.evaluate(async () => {
    const { callManager } = await import('/src/lib/family/familyCall.ts');
    return callManager.getSnapshot();
  });
}

test.describe('звонок между двумя телефонами', () => {
  test.setTimeout(90_000);

  test('мама звонит, Влад отвечает — оба на связи, звук идёт в обе стороны', async ({ browser }) => {
    const relay = makeRelay();
    const key = await familyKey(browser);
    const mom = await phone(browser, relay, key, MOM, VLAD);
    const vlad = await phone(browser, relay, key, VLAD, MOM);

    await mom.getByRole('button', { name: 'Позвонить: Влад' }).click();
    await expect(vlad.getByText('Входящий звонок')).toBeVisible({ timeout: 15_000 });
    await vlad.getByRole('button', { name: 'Ответить' }).click();
    await expectTalking(mom, vlad);
  });

  test('ответ потерялся по дороге — связь всё равно встаёт', async ({ browser }) => {
    // Телефон отвечающего в момент ответа переподключал сокет (вернулся из
    // фона, сменил сеть) — первый «ответ» ушёл в никуда. Звонящий при этом
    // продолжает слать приглашение: это и есть шанс повторить ответ.
    const relay = makeRelay();
    let lost = 0;
    relay.setCopies((f) => (f.kind === 'answer' && lost++ === 0 ? 0 : 1));
    const key = await familyKey(browser);
    const mom = await phone(browser, relay, key, MOM, VLAD);
    const vlad = await phone(browser, relay, key, VLAD, MOM);

    await mom.getByRole('button', { name: 'Позвонить: Влад' }).click();
    await expect(vlad.getByText('Входящий звонок')).toBeVisible({ timeout: 15_000 });
    await vlad.getByRole('button', { name: 'Ответить' }).click();
    await expectTalking(mom, vlad);
    expect(lost).toBeGreaterThan(1); // первый ответ правда потерян, дошёл повтор
  });

  test('приглашение пришло пачкой — звонит один раз, а принятый звонок не рвётся сам', async ({ browser }) => {
    // Телефон проснулся и получил разом всё, что накопилось в сокете, — три
    // копии приглашения. Каждая заводила свой таймер «пропущенного», а «Ответить»
    // гасил только последний: через время дозвона разговор обрывался сам.
    // Копии отдаются приложению в одном такте — так, как их разбирает
    // проснувшийся сокет; через сервер в тесте они приходили бы с зазором, и
    // поломка ловилась бы через раз.
    const relay = makeRelay();
    let held: Frame | null = null;
    let injected = false;
    // Пока пачка не отдана, приглашения Владу не идут — иначе обычный повтор
    // успел бы раньше неё.
    relay.setCopies((f) => {
      if (f.kind !== 'offer' || f.to !== VLAD.id || injected) return 1;
      held ??= f;
      return 0;
    });
    const key = await familyKey(browser);
    const mom = await phone(browser, relay, key, MOM, VLAD);
    const vlad = await phone(browser, relay, key, VLAD, MOM);
    await vlad.clock.install();

    await mom.getByRole('button', { name: 'Позвонить: Влад' }).click();
    await expect.poll(() => held !== null, { timeout: 15_000 }).toBe(true);
    await vlad.evaluate(async (f) => {
      const { callManager } = await import('/src/lib/family/familyCall.ts');
      for (let i = 0; i < 3; i++) void callManager.onSignal('f1', { type: 'signal', ...f } as never);
    }, held);
    injected = true;
    await expect(vlad.getByText('Входящий звонок')).toBeVisible({ timeout: 15_000 });
    await vlad.getByRole('button', { name: 'Ответить' }).click();
    await expectTalking(mom, vlad);

    await vlad.clock.fastForward(50_000);
    await expect(vlad.getByText('На связи')).toBeVisible();
    expect((await snapshot(vlad)).status).toBe('active');
  });

  test('звонящий отменил, пока входящий ещё появлялся, — никакого «призрака»', async ({ browser }) => {
    // Приглашение и «отбой» пришли одной пачкой. Отбой обработан, пока
    // приглашение ещё читало имя звонящего, — и раньше после него на экране
    // оставался входящий: звонит, а «Ответить» ничего не делает.
    const relay = makeRelay();
    const key = await familyKey(browser);
    const vlad = await phone(browser, relay, key, VLAD, MOM);
    await vlad.evaluate(async () => {
      const { callManager } = await import('/src/lib/family/familyCall.ts');
      const frame = (kind: string) => ({ type: 'signal', from: 'mom', to: 'vlad', call: 'c-ghost', kind, data: kind === 'offer' ? 'x' : null });
      void callManager.onSignal('f1', frame('offer') as never);
      void callManager.onSignal('f1', frame('cancel') as never);
    });
    await vlad.waitForTimeout(1500);
    expect((await snapshot(vlad)).status).not.toBe('incoming');
    await expect(vlad.getByText('Входящий звонок')).toHaveCount(0);
  });

  test('ответили на последних секундах дозвона — звонящий не сбрасывает «Не ответили»', async ({ browser }) => {
    // Ровно случай 03.11: Влад открыл приложение по пушу и нажал «Ответить»,
    // когда от дозвона оставались секунды. Пока его телефон брал микрофон и
    // собирал маршруты, дозвон у мамы истекал — и она сбрасывала уже
    // принятый звонок. Теперь «трубку сняли» уходит в момент нажатия.
    const relay = makeRelay();
    let holdAnswers = true;
    relay.setCopies((f) => (f.kind === 'answer' && holdAnswers ? 0 : 1));
    const key = await familyKey(browser);
    const mom = await phone(browser, relay, key, MOM, VLAD);
    const vlad = await phone(browser, relay, key, VLAD, MOM);
    await mom.clock.install();

    await mom.getByRole('button', { name: 'Позвонить: Влад' }).click();
    await expect(vlad.getByText('Входящий звонок')).toBeVisible({ timeout: 15_000 });
    await mom.clock.fastForward(40_000); // у мамы дозвон почти истёк
    await vlad.getByRole('button', { name: 'Ответить' }).click();
    await expect(mom.getByText('Соединение…')).toBeVisible({ timeout: 10_000 });
    await mom.clock.fastForward(10_000); // срок дозвона позади, ответ ещё в пути

    expect((await snapshot(mom)).endReason).not.toBe('Не ответили');
    expect(relay.kinds(MOM.id)).not.toContain('cancel');
    holdAnswers = false; // ответ дошёл (повтором на очередное приглашение)
    await expectTalking(mom, vlad);
  });

  test('трубку сняли, а маршрута нет — честный конец с разбором, а не «Не ответили»', async ({ browser }) => {
    // Ответ дошёл, маршрут ищется — а таймер дозвона у мамы продолжал тикать
    // и обрывал уже принятый звонок как неотвеченный, без следа в разборе.
    // Маршрута у Влада нет вовсе (только ретранслятор, а его нет), так что
    // соединение здесь не встанет никогда: проверяется именно исход.
    const relay = makeRelay();
    const key = await familyKey(browser);
    const mom = await phone(browser, relay, key, MOM, VLAD);
    const vlad = await phone(browser, relay, key, VLAD, MOM, () => {
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        constructor(cfg?: RTCConfiguration) {
          super({ ...cfg, iceTransportPolicy: 'relay' });
        }
      } as typeof RTCPeerConnection;
    });
    await mom.clock.install();

    await mom.getByRole('button', { name: 'Позвонить: Влад' }).click();
    await expect(vlad.getByText('Входящий звонок')).toBeVisible({ timeout: 15_000 });
    await vlad.getByRole('button', { name: 'Ответить' }).click();
    await expect(mom.getByText('Соединение…')).toBeVisible({ timeout: 15_000 });

    await mom.clock.fastForward(29_000);
    // Принятый, но не соединившийся звонок кончается таймером соединения — с
    // честной причиной и разбором на экране «Почему звонок не вышел».
    const failed = 'Не удалось соединиться — сеть не пропускает звонок';
    await expect.poll(async () => (await snapshot(mom)).endReason).toBe(failed);
    expect(relay.kinds(MOM.id)).not.toContain('cancel');
    const diag = await mom.evaluate(async () => (await import('/src/lib/family/familyCall.ts')).getCallDiag());
    expect(diag?.reason).toBe(failed);
  });

  test('связь переигрывается посреди разговора — собеседник принимает новое приглашение', async ({ browser }) => {
    // Восстановление после обрыва (лифт, смена Wi-Fi на LTE) — это новое
    // приглашение в том же звонке. Собеседник его молча выбрасывал как
    // «повтор», и восстанавливать разговор было бессмысленно.
    const relay = makeRelay();
    const key = await familyKey(browser);
    const mom = await phone(browser, relay, key, MOM, VLAD);
    const vlad = await phone(browser, relay, key, VLAD, MOM);

    await mom.getByRole('button', { name: 'Позвонить: Влад' }).click();
    await expect(vlad.getByText('Входящий звонок')).toBeVisible({ timeout: 15_000 });
    await vlad.getByRole('button', { name: 'Ответить' }).click();
    await expectTalking(mom, vlad);

    // Переигрывает тот, у кого id меньше («mom» < «vlad»), — так же решит и
    // само приложение при настоящем обрыве.
    const ufrag = (p: Page) =>
      p.evaluate(async () => {
        const { callManager } = await import('/src/lib/family/familyCall.ts');
        const pc = (callManager as unknown as { pc: RTCPeerConnection | null }).pc;
        return { remote: /a=ice-ufrag:(\S+)/.exec(pc?.remoteDescription?.sdp ?? '')?.[1], state: pc?.signalingState };
      });
    const before = await ufrag(mom);
    await mom.evaluate(async () => {
      const { callManager } = await import('/src/lib/family/familyCall.ts');
      const cm = callManager as unknown as { pc: RTCPeerConnection; restartIce(pc: RTCPeerConnection): Promise<void> };
      await cm.restartIce(cm.pc);
    });
    await expect.poll(async () => (await ufrag(mom)).state, { timeout: 10_000 }).toBe('stable');
    expect((await ufrag(mom)).remote).not.toBe(before.remote);
    await expectTalking(mom, vlad);
  });

  test('связь пропала насовсем — через срок восстановления обе стороны знают об этом', async ({ browser }) => {
    // Мамин телефон пропал посреди разговора (сел, ушёл из сети). Влад — не
    // та сторона, что переигрывает соединение, и раньше просто ждал: без
    // срока «Восстанавливаю связь…» висело, пока не сбросишь руками.
    const relay = makeRelay();
    const key = await familyKey(browser);
    const mom = await phone(browser, relay, key, MOM, VLAD);
    const vlad = await phone(browser, relay, key, VLAD, MOM);
    await vlad.clock.install();

    await mom.getByRole('button', { name: 'Позвонить: Влад' }).click();
    await expect(vlad.getByText('Входящий звонок')).toBeVisible({ timeout: 15_000 });
    await vlad.getByRole('button', { name: 'Ответить' }).click();
    await expectTalking(mom, vlad);

    // Соединение у мамы закрыто молча — сигналов «до свидания» нет.
    await mom.evaluate(async () => {
      const { callManager } = await import('/src/lib/family/familyCall.ts');
      (callManager as unknown as { pc: RTCPeerConnection }).pc.close();
    });
    await expect.poll(async () => (await snapshot(vlad)).reconnecting, { timeout: 30_000 }).toBe(true);
    await vlad.clock.fastForward(41_000);

    await expect.poll(async () => (await snapshot(vlad)).endReason).toBe('Связь не восстановилась');
    expect(relay.kinds(VLAD.id)).toContain('hangup'); // маме сказали, а не бросили
    const diag = await vlad.evaluate(async () => (await import('/src/lib/family/familyCall.ts')).getCallDiag());
    expect(diag?.reason).toBe('Связь не восстановилась');
  });
});
