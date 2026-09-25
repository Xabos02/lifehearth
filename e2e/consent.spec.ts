import type { Page } from '@playwright/test';
import { openApp, test, expect, OPEN_METEO_MATCH } from './fixtures';

// Одно окно согласия (задача 34): без согласия всё внешнее выключено, а
// любая попытка включить внешнее открывает то же окно.
//
// Сеть здесь видна тремя способами, и нужны все три. page.on('request')
// видит HTTP, в том числе оборванные фикстурой запросы к воркеру. Сокеты,
// WebRTC и распознавание речи идут мимо него — их считают шпионы на
// конструкторах, поставленные до скриптов приложения.

const SPY = () => {
  const w = window as unknown as Record<string, unknown> & { __egress: { ws: string[]; rtc: number; speech: number } };
  w.__egress = { ws: [], rtc: 0, speech: 0 };
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(url: string | URL, p?: string | string[]) {
      w.__egress.ws.push(String(url));
      super(url, p);
    }
  } as typeof WebSocket;
  const RTC = window.RTCPeerConnection;
  if (RTC) {
    window.RTCPeerConnection = class extends RTC {
      constructor(c?: RTCConfiguration) {
        w.__egress.rtc++;
        super(c);
      }
    } as typeof RTCPeerConnection;
  }
  // Распознаватель — подставной: в headless настоящий всё равно не работает,
  // а нам важно одно — позвали ли start().
  class FakeSpeech {
    lang = '';
    interimResults = false;
    continuous = false;
    onresult: unknown = null;
    onend: (() => void) | null = null;
    onerror: unknown = null;
    start() {
      w.__egress.speech++;
    }
    stop() {
      this.onend?.();
    }
    abort() {}
  }
  w.SpeechRecognition = FakeSpeech;
  w.webkitSpeechRecognition = FakeSpeech;
};

/** Запросы с чужих хостов — всё, что не сам дев-сервер приложения. */
function watchNet(page: Page, baseURL: string | undefined) {
  const own = new URL(baseURL ?? 'http://127.0.0.1:5199/').host;
  const external: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return;
    if (u.host !== own) external.push(r.url());
  });
  return external;
}

/** Что насчитали шпионы. Сокет самого дев-сервера (горячая перезагрузка
 *  Vite) — свой origin, не выход наружу. */
async function spied(page: Page) {
  return page.evaluate(() => {
    const e = (window as unknown as { __egress: { ws: string[]; rtc: number; speech: number } }).__egress;
    return { ...e, ws: e.ws.filter((u) => new URL(u).host !== location.host) };
  });
}

/** Обновившийся: синк, семья, напоминание в очереди — всё включено до окна. */
async function seedUpdater(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    const ts = new Date().toISOString();
    await db.sync.put({
      id: 'config', accountId: 'acc-e2e', authToken: 'tok-e2e', key, enabled: true,
      lastPullAt: '', lastPushAt: '', lastSyncedAt: '',
    } as never);
    await db.family.put({
      id: 'f1', familyId: 'f1', familyToken: 't', familyKey: key, familyName: 'Наши', selfMemberId: 'me',
      lastSeq: 0, lastReadSeq: 0, enabled: true, joinedAt: ts, keyEpoch: 0, keyRing: { '0': key },
    } as never);
    await db.tasks.put({
      id: 'r1', title: 'Позвонить маме', dueDate: '2099-01-10', dueTime: '10:00', remindBefore: 30,
      projectId: null, notes: '', tags: [], checklist: [], priority: 0, duration: null,
      completedAt: null, deletedAt: null, createdAt: ts, updatedAt: ts, sortOrder: 1000,
    } as never);
    localStorage.setItem('life-hub-push-sub', JSON.stringify({ endpoint: 'https://push.example/x' }));
    localStorage.setItem('life-hub-reminder-retry', JSON.stringify(['r1']));
  });
}

const WEATHER = {
  current: { temperature_2m: 17.4, weather_code: 1, is_day: 1, apparent_temperature: 16 },
  daily: { temperature_2m_max: [20], temperature_2m_min: [11] },
};

test('новый человек: окно после тура, «Не сейчас» — и само оно больше не всплывает', async ({ page, baseURL }) => {
  await page.addInitScript(SPY);
  const external = watchNet(page, baseURL);
  await openApp(page, '/', { consentAt: null });

  const dialog = page.getByRole('dialog', { name: 'Что уходит с телефона' });
  await expect(dialog).toBeVisible();
  // Внешнего у нового человека нет — отказ ничего не ставит на паузу.
  await expect(dialog.getByText('Сейчас у вас включено')).toHaveCount(0);

  // Подробный список — по строке на каждый канал из перечня хостов: текст
  // окна не может отстать от того, что реально уходит.
  await dialog.getByRole('button', { name: 'Подробно, по каждой функции' }).click();
  const channels = await page.evaluate(async () => Object.keys((await import('/src/lib/consent.ts')).EGRESS_HOSTS));
  for (const id of channels) await expect(dialog.locator(`[data-channel="${id}"]`)).toBeVisible();
  // Женский профиль (фикстура): строка про «Женские дни» есть.
  await expect(dialog.getByText('«Женские дни» ассистенту недоступны.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Коротко' }).click();

  await dialog.getByRole('button', { name: 'Не сейчас' }).click();
  await expect(dialog).toBeHidden();

  await page.reload();
  await expect(page.locator('#root')).not.toBeEmpty();
  await page.waitForTimeout(800);
  await expect(dialog).toBeHidden();
  // Погоды без согласия нет: ни ячейки, ни запроса.
  await expect(page.getByLabel('Сегодня коротко')).toHaveCount(0);
  expect(external, 'без согласия — ни одного запроса наружу').toEqual([]);
  expect((await spied(page)).ws).toEqual([]);

  // Перечитать из настроек — то же окно; ответ «Не сейчас» не сброшен.
  await page.goto('/more/settings');
  await expect(page.getByText('нет согласия', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Что уходит с телефона/ }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Принимаю' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/^принято \d+ /)).toBeVisible();

  await page.goto('/');
  await page.waitForTimeout(500);
  await expect(dialog).toBeHidden();
});

test('мужской профиль: о «Женских днях» в окне ни слова', async ({ page }) => {
  await openApp(page, '/', { consentAt: null, gender: 'male' });
  const dialog = page.getByRole('dialog', { name: 'Что уходит с телефона' });
  await dialog.getByRole('button', { name: 'Подробно, по каждой функции' }).click();
  await expect(dialog.locator('[data-channel="ai"]')).toBeVisible();
  await expect(dialog.getByText(/Женские дни/)).toHaveCount(0);
});

test('обновившийся: «Не сейчас» нет, отказ — пауза без единого запроса, «Принимаю» возвращает всё', async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(SPY);
  await page.route(OPEN_METEO_MATCH, (r) => r.fulfill({ json: WEATHER }));
  // Уведомления у обновившегося разрешены: без этого «На паузе» у них не
  // проверить — pushPaused() требует выданного разрешения. grantPermissions
  // здесь не действует (headless-Chromium на 127.0.0.1 отвечает 'denied'),
  // поэтому разрешение подставляется до скриптов приложения.
  await page.addInitScript(() =>
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' }),
  );
  const external = watchNet(page, baseURL);
  await openApp(page, '/', { consentAt: null, aiEnabled: true, autoBackup: 'cloud', autoBackupEvery: 'daily' });
  await seedUpdater(page);
  await page.goto('/');

  const dialog = page.getByRole('dialog', { name: 'Что уходит с телефона' });
  await expect(dialog.getByText('Сейчас у вас включено')).toBeVisible();
  for (const chip of ['Синхронизация', 'Семья', 'Уведомления', 'Ассистент']) {
    await expect(dialog.getByText(chip, { exact: true })).toBeVisible();
  }
  // Случайно смахнуть нельзя: отказ назван тем, что он делает.
  await expect(dialog.getByRole('button', { name: 'Не сейчас' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Не принимать — поставить на паузу' }).click();
  await expect(dialog).toBeHidden();

  // Пауза видна там, где человек будет искать.
  await page.goto('/more/family');
  await expect(page.getByText('Семья на паузе')).toBeVisible();
  await page.goto('/more/settings');
  await expect(page.getByText('Внешнее на паузе')).toBeVisible();
  // Уведомления и синк — «На паузе», а не «Включены» и не «Включить».
  await expect(page.getByText('На паузе', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Включены', { exact: true })).toHaveCount(0);
  // Возврат в приложение — тот путь, которым синк и семья поднимаются сами.
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
  });
  await page.waitForTimeout(1500);
  expect(external, 'на паузе — ни одного запроса наружу').toEqual([]);
  const idle = await spied(page);
  expect(idle.ws).toEqual([]);
  expect(idle.rtc).toBe(0);
  // Настройки не стёрты: синк включён, группа на месте, напоминание в очереди.
  expect(
    await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      const s = await db.settings.get('app');
      return {
        sync: (await db.sync.get('config'))?.enabled,
        family: (await db.family.get('f1'))?.enabled,
        queue: localStorage.getItem('life-hub-reminder-retry'),
        // Пауза — не «копия сделана»: отказ сервера не записан как успех.
        backupAt: s?.lastCloudBackupAt ?? null,
        autoBackup: s?.autoBackup,
      };
    }),
  ).toEqual({ sync: true, family: true, queue: '["r1"]', backupAt: null, autoBackup: 'cloud' });

  await page.getByRole('button', { name: 'Прочитать и принять' }).click();
  await dialog.getByRole('button', { name: 'Принимаю' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Внешнее на паузе')).toHaveCount(0);

  // Всё вернулось без перезагрузки: обмен, семья, отложенное напоминание.
  await expect.poll(() => external.some((u) => u.includes('/sync/pull'))).toBe(true);
  await expect.poll(() => external.some((u) => u.includes('/family/'))).toBe(true);
  await expect.poll(() => external.some((u) => u.endsWith('/schedule'))).toBe(true);
  await expect.poll(() => external.some((u) => u.includes('/backup/'))).toBe(true);
  await page.goto('/');
  await expect(page.getByLabel('Сегодня коротко')).toContainText('17');

  // Каждый адрес, куда ушёл запрос, — из перечня в lib/consent.ts.
  const hosts = await page.evaluate(async () => {
    const c = await import('/src/lib/consent.ts');
    return [...Object.values(c.EGRESS_HOSTS).flat(), ...c.ON_TAP_HOSTS];
  });
  const unknown = external.map((u) => new URL(u).host).filter((h) => !hosts.includes(h));
  expect(unknown, 'адрес вне перечня — впишите его в lib/consent.ts').toEqual([]);
});

test('попытка включить внешнее открывает то же окно; отказ — ничего не уходит, согласие — действие продолжается', async ({
  page,
  baseURL,
}) => {
  const external = watchNet(page, baseURL);
  const ai: string[] = [];
  await page.route('**/ai/chat', (route) => {
    ai.push(route.request().url());
    return route.fulfill({
      contentType: 'application/json',
      json: { content: 'Ответ после согласия.', model: 'echo', usage: { in: 1, out: 2 } },
    });
  });
  // Окно уже закрывали: само оно не всплывёт, только по попытке.
  await openApp(page, '/more/settings', { consentAt: null, consentAskedAt: new Date().toISOString() });
  const dialog = page.getByRole('dialog');

  await page.getByRole('button', { name: 'Включить синхронизацию' }).click();
  await expect(dialog.getByRole('heading', { name: 'Синхронизации нужно согласие' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Не сейчас' }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(async () => (await import('/src/db/db.ts')).db.sync.get('config'))).toBeUndefined();
  expect(external).toEqual([]);

  // Ассистент: вопрос не записан и не отправлен, черновик на месте.
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    await db.sync.put({
      id: 'config', accountId: 'acc-e2e', authToken: 'tok-e2e', key: await generateKey(), enabled: true,
      lastPullAt: '', lastPushAt: '', lastSyncedAt: '',
    } as never);
  });
  await page.goto('/more/ai');
  const input = page.getByPlaceholder('Сообщение…');
  await input.fill('вопрос');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(dialog.getByRole('heading', { name: 'Ассистенту нужно согласие' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Не сейчас' }).click();
  await expect(input).toHaveValue('вопрос');
  expect(ai).toEqual([]);
  expect(
    await page.evaluate(async () => (await import('/src/db/db.ts')).db.llmMessages.filter((m) => m.role === 'user').count()),
  ).toBe(0);

  await page.getByRole('button', { name: 'Отправить' }).click();
  await dialog.getByRole('button', { name: 'Принимаю' }).click();
  await expect(page.getByText('Ответ после согласия.')).toBeVisible();
  expect(ai).toHaveLength(1);
});

test.describe('голосовой ввод', () => {
  // На профиле iPhone приложение голос не слушает вовсе (подсказка про
  // диктовку клавиатуры) — сеть делает только ветка браузера с распознаванием.
  test.use({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });

  test('микрофон без согласия открывает окно, после «Принимаю» начинает слушать', async ({ page }) => {
    await page.addInitScript(SPY);
    await openApp(page, '/tasks', { consentAt: null, consentAskedAt: new Date().toISOString() });
    const dialog = page.getByRole('dialog');
    await page.getByRole('button', { name: 'Голосовой ввод' }).first().click();
    await expect(dialog.getByRole('heading', { name: 'Голосовому вводу нужно согласие' })).toBeVisible();
    expect((await spied(page)).speech).toBe(0);
    await dialog.getByRole('button', { name: 'Принимаю' }).click();
    await expect.poll(async () => (await spied(page)).speech).toBe(1);
  });
});
