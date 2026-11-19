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

/** Звонок на связи: в состоянии — «active», на экране звонка — идущий таймер
 *  (активный звонок показывает время, а не слово «На связи»; раньше проверка
 *  по тексту случайно цеплялась за «на связи» в шапке чата). */
async function expectConnected(p: Page, timeout = 15_000) {
  await expect.poll(async () => (await snapshot(p)).status, { timeout }).toBe('active');
  await expect(p.getByText(/^\d+:\d{2}$/).first()).toBeVisible();
}

/** Оба на связи и звук идёт: у каждого растёт счётчик принятых аудиопакетов. */
async function expectTalking(...pages: Page[]) {
  for (const p of pages) await expectConnected(p);
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

/** Сколько аудиопакетов принято — счётчик накопительный, поэтому «звук идёт
 *  сейчас» проверяется ростом от замера к замеру. */
async function packets(p: Page): Promise<number> {
  return p.evaluate(async () => {
    const { callManager } = await import('/src/lib/family/familyCall.ts');
    const pc = (callManager as unknown as { pc: RTCPeerConnection | null }).pc;
    let n = 0;
    (await pc?.getStats())?.forEach((s: RTCStats & { kind?: string; packetsReceived?: number }) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') n = s.packetsReceived ?? 0;
    });
    return n;
  });
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
    await expectConnected(vlad);
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
    await mom.clock.fastForward(35_000); // у мамы дозвон почти истёк
    await vlad.getByRole('button', { name: 'Ответить' }).click();
    await expect(mom.getByText('Соединение…')).toBeVisible({ timeout: 10_000 });
    await mom.clock.fastForward(15_000); // срок дозвона позади, ответ ещё в пути

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
    // И звук после переигровки идёт дальше, а не только шёл до неё.
    for (const p of [mom, vlad]) {
      const was = await packets(p);
      await expect.poll(() => packets(p), { timeout: 10_000 }).toBeGreaterThan(was + 10);
    }
    await expectConnected(mom);
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
    await expect.poll(async () => (await snapshot(mom)).endReason).toBe('Звонок завершён');
    const diag = await vlad.evaluate(async () => (await import('/src/lib/family/familyCall.ts')).getCallDiag());
    expect(diag?.reason).toBe('Связь не восстановилась');
  });
});

// iPhone: разговор «к уху» и сворачивание приложения.
//
// В Safari звонок с микрофоном по умолчанию идёт в громкоговоритель
// (PlayAndRecord + DefaultToSpeaker), а navigator.audioSession маршрут не
// меняет — раньше кнопка «К уху» горела, а звук шёл в динамик. На слуховой
// динамик звук уводит только выбор выхода страницей (setSinkId на приёмник), и
// в Safari 26 он держится только на локальной дорожке — поэтому звук
// собеседника идёт через WebAudio-ретранслятор. Выход Safari меняет лишь в
// течение 5 секунд после касания. И экран: раньше его держали весь разговор, и
// у уха щека жала кнопки; теперь у уха блокировка отпускается — iPhone гасит и
// запирает экран сам.
//
// Chromium не iPhone: здесь подставлены сессия звука, выходы с именами iOS 26,
// смена выхода с журналом (и отказом, когда касание было давно) и блокировка
// экрана, которую, как в WebKit, снимает уход в фон. Звук между телефонами —
// настоящий.
function iphone() {
  const log = { sinks: [] as string[], held: 0, refuse: false, headset: false, stuck: false };
  (window as unknown as { __ear: typeof log }).__ear = log;
  Object.defineProperty(navigator, 'audioSession', { value: { type: 'auto' }, configurable: true });
  const md = navigator.mediaDevices;
  const enumerate = md.enumerateDevices.bind(md);
  md.enumerateDevices = async () => [
    ...(await enumerate()).filter((d) => d.kind !== 'audiooutput'),
    { kind: 'audiooutput', deviceId: 'spk', label: 'Main Speaker', groupId: 'b' } as MediaDeviceInfo,
    { kind: 'audiooutput', deviceId: 'rcv', label: 'Earpiece Speaker', groupId: 'b' } as MediaDeviceInfo,
    ...(log.headset ? [{ kind: 'audiooutput', deviceId: 'pods', label: 'AirPods Pro', groupId: 'p' } as MediaDeviceInfo] : []),
  ];
  // Chromium (в отличие от WebKit, который опрашивает libwebrtc сам) не отдаёт
  // удалённый звук в WebAudio, пока дорожку не играет media-элемент, — даём ему
  // немой, чтобы ретранслятор в тесте звучал, как на iPhone.
  const PC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends PC {
    constructor(c?: RTCConfiguration) {
      super(c);
      this.addEventListener('track', (e) => {
        const el = document.createElement('audio');
        el.muted = true;
        el.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        void el.play().catch(() => {});
      });
    }
  };
  // WebAudio, который Safari так и не запустил (создан без касания).
  const AC = window.AudioContext;
  window.AudioContext = class extends AC {
    constructor(o?: AudioContextOptions) {
      super(o);
      if (log.stuck) void super.suspend();
    }
    resume() {
      return log.stuck ? Promise.resolve() : super.resume();
    }
  };
  const proto = HTMLMediaElement.prototype as unknown as { setSinkId(id: string): Promise<void>; sinkId: string };
  let sink = '';
  Object.defineProperty(proto, 'sinkId', { get: () => sink, configurable: true });
  proto.setSinkId = async (id: string) => {
    if (log.refuse) throw new DOMException('A user gesture is required', 'NotAllowedError');
    log.sinks.push(id);
    sink = id;
  };
  const sentinels = new Set<EventTarget & { release(): Promise<void> }>();
  const drop = (s: EventTarget & { release(): Promise<void> }) => {
    if (!sentinels.delete(s)) return;
    log.held = sentinels.size;
    s.dispatchEvent(new Event('release'));
  };
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: async () => {
        const s = Object.assign(new EventTarget(), { release: async () => drop(s) });
        sentinels.add(s);
        log.held = sentinels.size;
        return s;
      },
    },
  });
  // Свернуть/развернуть приложение — по команде теста.
  let state: DocumentVisibilityState = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => state, configurable: true });
  Object.defineProperty(document, 'hidden', { get: () => state === 'hidden', configurable: true });
  (window as unknown as { __setVisible(v: boolean): void }).__setVisible = (v) => {
    state = v ? 'visible' : 'hidden';
    if (!v) for (const s of [...sentinels]) drop(s);
    document.dispatchEvent(new Event('visibilitychange'));
  };
}

type EarLog = { sinks: string[]; held: number; refuse: boolean; headset: boolean; stuck: boolean };
const setEar = (p: Page, patch: Partial<EarLog>) =>
  p.evaluate((patch) => Object.assign((window as unknown as { __ear: EarLog }).__ear, patch), patch);
const ear = (p: Page) => p.evaluate(() => (window as unknown as { __ear: EarLog }).__ear);
const setVisible = (p: Page, v: boolean) =>
  p.evaluate((v) => (window as unknown as { __setVisible(v: boolean): void }).__setVisible(v), v);
const toggleSpeaker = (p: Page) =>
  p.evaluate(async () => (await import('/src/lib/family/familyCall.ts')).callManager.toggleSpeaker());
/** Звук собеседника играет через ретранслятор, а не прямой WebRTC-дорожкой. */
const relayed = (p: Page) =>
  p.evaluate(async () => {
    const { callManager } = await import('/src/lib/family/familyCall.ts');
    const cm = callManager as unknown as { audioEl: HTMLAudioElement | null; remoteStream: MediaStream | null };
    const src = cm.audioEl?.srcObject as MediaStream | null;
    return !!src && !!cm.remoteStream && src !== cm.remoteStream;
  });
/** Громкость того, что выходит из ретранслятора: звук правда идёт, а не
 *  только пакеты (поддельный микрофон Chromium пищит). */
const relayLevel = (p: Page) =>
  p.evaluate(async () => {
    const { callManager } = await import('/src/lib/family/familyCall.ts');
    const cm = callManager as unknown as { relayCtx: AudioContext; relayOut: MediaStream };
    const src = cm.relayCtx.createMediaStreamSource(cm.relayOut); // то, что уходит в <audio>
    const an = cm.relayCtx.createAnalyser();
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let max = 0;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      an.getFloatTimeDomainData(buf);
      for (const v of buf) max = Math.max(max, Math.abs(v));
    }
    src.disconnect();
    return max;
  });
const callAudio = (p: Page) =>
  p.evaluate(async () => (await import('/src/lib/family/familyCall.ts')).getCallAudio());

// Телефоны этих тестов закрываются после каждого: иначе к последним тестам
// файла в одном воркере живут десятки страниц с идущими звонками, и дозвон не
// укладывается в свои 15 с (так и падал четвёртый из них в общем прогоне).
const opened: Page[] = [];

async function talk(browser: Browser, before?: (mom: Page) => Promise<void>) {
  const relay = makeRelay();
  const key = await familyKey(browser);
  const mom = await phone(browser, relay, key, MOM, VLAD, iphone);
  const vlad = await phone(browser, relay, key, VLAD, MOM);
  opened.push(mom, vlad);
  await before?.(mom);
  await mom.getByRole('button', { name: 'Позвонить: Влад' }).click();
  // На дозвоне экран держится: человек смотрит, взяли ли трубку.
  await expect.poll(async () => (await ear(mom)).held).toBe(1);
  await expect(vlad.getByText('Входящий звонок')).toBeVisible({ timeout: 15_000 });
  await vlad.getByRole('button', { name: 'Ответить' }).click();
  await expectTalking(mom, vlad);
  return { mom, vlad };
}

test.describe('iPhone: к уху и свёрнутое приложение', () => {
  test.setTimeout(90_000);
  test.afterEach(async () => {
    for (const p of opened.splice(0)) await p.context().close();
  });

  test('разговор начинается у уха, экран отпущен; громкая связь возвращает экран', async ({ browser }) => {
    const { mom } = await talk(browser);

    // Звук ушёл на слуховой динамик, и через ретранслятор — иначе Safari 26
    // молча вернул бы его в громкоговоритель.
    expect((await ear(mom)).sinks).toEqual(['rcv']);
    expect(await relayed(mom)).toBe(true);
    expect(await relayLevel(mom)).toBeGreaterThan(0.01);
    expect((await snapshot(mom)).speakerOn).toBe(false);
    expect(await callAudio(mom)).toEqual({ outputs: ['Main Speaker', 'Earpiece Speaker'], ear: true });
    // Экран отпущен — iPhone погасит его сам; от щеки до тех пор закрывает защита.
    await expect.poll(async () => (await ear(mom)).held).toBe(0);
    await expect(mom.getByText('Экран заблокирован, чтобы не нажать щекой')).toBeVisible();

    await toggleSpeaker(mom);
    expect((await ear(mom)).sinks.at(-1)).toBe(''); // системный выход — громкоговоритель
    await expect.poll(async () => (await ear(mom)).held).toBe(1);
    expect(await relayed(mom)).toBe(true);

    await toggleSpeaker(mom);
    expect((await ear(mom)).sinks.at(-1)).toBe('rcv');
    await expect.poll(async () => (await ear(mom)).held).toBe(0);
  });

  test('касание было давно — Safari не дал сменить выход: разговор на громкой, «К уху» — кнопкой', async ({ browser }) => {
    const { mom } = await talk(browser, (mom) => setEar(mom, { refuse: true }));

    expect((await snapshot(mom)).speakerOn).toBe(true); // не врёт «к уху»
    expect((await snapshot(mom)).speakerAvailable).toBe(true);
    expect(await callAudio(mom)).toMatchObject({ ear: false, error: 'NotAllowedError' });
    expect((await ear(mom)).held).toBe(1); // на громкой экран держится

    await setEar(mom, { refuse: false });
    await toggleSpeaker(mom);
    expect((await ear(mom)).sinks).toEqual(['rcv']);
    expect((await snapshot(mom)).speakerOn).toBe(false);
    await expect.poll(async () => (await ear(mom)).held).toBe(0);
  });

  test('подключены наушники — звук остаётся в них, «К уху» — кнопкой', async ({ browser }) => {
    const { mom } = await talk(browser, (mom) => setEar(mom, { headset: true }));
    expect((await ear(mom)).sinks).toEqual([]); // в трубку насильно не уводим
    expect((await snapshot(mom)).speakerOn).toBe(true);
    expect((await snapshot(mom)).speakerAvailable).toBe(true);
    await toggleSpeaker(mom);
    expect((await ear(mom)).sinks).toEqual(['rcv']);
  });

  test('WebAudio не запустился — звук идёт напрямую, кнопка не врёт про «к уху»', async ({ browser }) => {
    // Ретранслятор нужен только для «к уху»; без него звонок не должен
    // остаться без звука — это хуже громкой связи.
    const { mom } = await talk(browser, (mom) => setEar(mom, { stuck: true }));
    expect(await relayed(mom)).toBe(false);
    expect((await ear(mom)).sinks).toEqual([]);
    expect((await snapshot(mom)).speakerOn).toBe(true);
    await toggleSpeaker(mom); // касание, но WebAudio так и стоит
    expect((await snapshot(mom)).speakerOn).toBe(true);
    expect(await relayed(mom)).toBe(false);
    // Выход вернули на системный: исправленный Safari не увёл бы звук к уху молча.
    await expect.poll(async () => (await ear(mom)).sinks).toEqual(['rcv', '']);
  });

  test('свернули и вернулись — разговор идёт, экран у уха не захватывается снова', async ({ browser }) => {
    const { mom, vlad } = await talk(browser);
    await expect.poll(async () => (await ear(mom)).held).toBe(0);

    // Свёрнуто: звонок не закрывается и звук идёт в обе стороны.
    await setVisible(mom, false);
    for (const p of [mom, vlad]) {
      const was = await packets(p);
      await expect.poll(() => packets(p), { timeout: 10_000 }).toBeGreaterThan(was + 10);
    }
    expect((await snapshot(mom)).status).toBe('active');
    await setVisible(mom, true);
    expect((await ear(mom)).held).toBe(0);

    // На громкой связи экран после возврата снова держится.
    await toggleSpeaker(mom);
    await expect.poll(async () => (await ear(mom)).held).toBe(1);
    await setVisible(mom, false);
    expect((await ear(mom)).held).toBe(0);
    await setVisible(mom, true);
    await expect.poll(async () => (await ear(mom)).held).toBe(1);
    await expectConnected(mom);
  });
});
