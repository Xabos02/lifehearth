import { test, expect, openApp, type Page } from './fixtures';

// Свёрнутый звонок переносится удержанием (просьба Влада 20.11.2026: «чтобы
// иконку звонка можно было перемещать куда удобно пользователю нажатием и
// удержанием»). Тап по плашке по-прежнему разворачивает звонок, удержание
// 400 мс берёт её, и место остаётся за плашкой между звонками и перезапусками.
//
// Жест — настоящим касанием через CDP, а не мышью: touch-action действует
// только на касание, и мышью спек остался бы зелёным, даже если бы прокрутка
// отнимала жест у пальца.

const BAR = /Развернуть звонок/;
const POS_KEY = 'life-hub-call-bar-pos';

/** Звонок без сети не поднять — «идёт разговор» ставится напрямую, и оверлей
 *  сворачивается настоящей кнопкой (как в contrast.spec). */
async function minimizedCall(page: Page) {
  await page.evaluate(async () => {
    const { callManager } = await import('/src/lib/family/familyCall.ts');
    (callManager as unknown as { set(p: object): void })
      .set({ status: 'active', familyId: 'f1', peerId: 'mom', peerName: 'Мама', startedAt: Date.now() });
  });
  await page.getByRole('button', { name: 'Свернуть звонок' }).click();
  await expect(page.getByRole('button', { name: BAR })).toBeVisible();
}

async function box(page: Page) {
  const b = await page.getByRole('button', { name: BAR }).boundingBox();
  if (!b) throw new Error('плашки звонка нет на экране');
  return b;
}

/** Палец на плашке: касание в середину, ждём захвата (хук ставит touchAction
 *  'none' в миг срабатывания удержания — без угадывания миллисекунд под
 *  нагрузкой), дальше палец ведётся шагами. */
async function grab(page: Page) {
  const b = await box(page);
  const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, p?: { x: number; y: number }) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1 }] : [] } as never);
  await touch('touchStart', at);
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('[aria-label^="Развернуть звонок"]')?.style.touchAction === 'none',
  );
  return {
    /** Повести палец в точку (абсолютные координаты экрана). */
    moveTo: async (x: number, y: number) => {
      for (let i = 1; i <= 12; i++) {
        await touch('touchMove', { x: at.x + ((x - at.x) * i) / 12, y: at.y + ((y - at.y) * i) / 12 });
      }
    },
    release: () => touch('touchEnd'),
    cancel: () => touch('touchCancel'),
  };
}

test('свёрнутый звонок: удержание пальцем переносит плашку в рамке над таб-баром, тап разворачивает', async ({ page }) => {
  await openApp(page, '/');
  await minimizedCall(page);
  const vp = page.viewportSize()!;
  const nav = (await page.getByRole('navigation').last().boundingBox())!;

  // По умолчанию — сверху справа, как было до переноса.
  const start = await box(page);
  expect(Math.round(vp.width - (start.x + start.width))).toBe(12);
  expect(Math.round(start.y)).toBe(10);

  // Палец уходит в левый нижний угол, поверх таб-бара: плашка упирается в
  // рамку хода — у левого края и НАД таб-баром, а не под ним.
  let finger = await grab(page);
  await finger.moveTo(2, vp.height - 2);
  await finger.release();
  const corner = await box(page);
  expect(Math.round(corner.x)).toBe(12);
  expect(corner.y + corner.height).toBeLessThanOrEqual(nav.y - 8);
  expect(corner.y + corner.height).toBeGreaterThan(nav.y - 16);
  // Удержание не развернуло звонок.
  await expect(page.getByRole('button', { name: 'Свернуть звонок' })).toHaveCount(0);

  // В середине поля плашка идёт ровно за пальцем.
  finger = await grab(page);
  await finger.moveTo(corner.x + corner.width / 2 + 90, corner.y + corner.height / 2 - 200);
  await finger.release();
  const mid = await box(page);
  expect(Math.abs(mid.x - (corner.x + 90))).toBeLessThan(1.5);
  expect(Math.abs(mid.y - (corner.y - 200))).toBeLessThan(1.5);

  // Короткий тап разворачивает звонок.
  await page.getByRole('button', { name: BAR }).tap();
  await expect(page.getByRole('button', { name: 'Свернуть звонок' })).toBeVisible();
});

test('свёрнутый звонок: место остаётся за плашкой — в следующий раз и после перезагрузки', async ({ page }) => {
  await openApp(page, '/');
  await minimizedCall(page);
  const start = await box(page);
  const finger = await grab(page);
  await finger.moveTo(start.x + start.width / 2 - 120, start.y + start.height / 2 + 300);
  await finger.release();
  const moved = await box(page);
  expect(moved.y - start.y).toBeGreaterThan(250);

  // Развернули и свернули снова — плашка на своём новом месте.
  await page.getByRole('button', { name: BAR }).tap();
  await page.getByRole('button', { name: 'Свернуть звонок' }).click();
  const again = await box(page);
  expect(Math.abs(again.x - moved.x)).toBeLessThan(1.5);
  expect(Math.abs(again.y - moved.y)).toBeLessThan(1.5);

  // Перезапуск: звонка уже нет, но следующий свёрнутый встаёт туда же.
  await page.reload();
  await expect(page.locator('#root')).toBeVisible();
  await minimizedCall(page);
  const afterReload = await box(page);
  expect(Math.abs(afterReload.x - moved.x)).toBeLessThan(1.5);
  expect(Math.abs(afterReload.y - moved.y)).toBeLessThan(1.5);
});

test('свёрнутый звонок: жест, отнятый системой, возвращает плашку и ничего не запоминает', async ({ page }) => {
  await openApp(page, '/');
  await minimizedCall(page);
  const start = await box(page);

  const finger = await grab(page);
  await finger.moveTo(start.x + start.width / 2 - 150, start.y + start.height / 2 + 250);
  expect((await box(page)).y - start.y).toBeGreaterThan(200); // плашка правда ехала за пальцем
  await finger.cancel();

  const back = await box(page);
  expect(Math.abs(back.x - start.x)).toBeLessThan(1.5);
  expect(Math.abs(back.y - start.y)).toBeLessThan(1.5);
  expect(await page.evaluate((k) => localStorage.getItem(k), POS_KEY)).toBeNull();
});

test('свёрнутый звонок: звонок кончился, пока палец вёл плашку, — место не записано', async ({ page }) => {
  await openApp(page, '/');
  await minimizedCall(page);
  const start = await box(page);

  const finger = await grab(page);
  await finger.moveTo(start.x + start.width / 2 - 150, start.y + start.height / 2 + 250);
  await page.evaluate(async () => {
    const { callManager } = await import('/src/lib/family/familyCall.ts');
    (callManager as unknown as { set(p: object): void }).set({ status: 'idle' });
  });
  await expect(page.getByRole('button', { name: BAR })).toHaveCount(0);
  await finger.release();
  expect(await page.evaluate((k) => localStorage.getItem(k), POS_KEY)).toBeNull();
});
