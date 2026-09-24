import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Жест закрытия шторки живёт на её шапке. Без порога панель шла за пальцем с
// первого пикселя, и любое касание шапки — тап по заголовку, промах мимо
// крестика — заставляло её вздрагивать. Теперь первые 12px вниз ещё не жест,
// а уход пальца вбок отменяет его совсем.

async function openTaskSheet(page: Page) {
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toBeVisible();
}

const panel = (page: Page) => page.locator('[class*="animate-sheet-up"]');

async function settledTop(page: Page) {
  return panel(page).evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
    return el.getBoundingClientRect().top;
  });
}

/** Точка на шапке слева от крестика — там, куда палец и берётся. */
async function grip(page: Page) {
  const box = await panel(page).locator('.cursor-grab').boundingBox();
  if (!box) throw new Error('нет шапки шторки');
  return { x: box.x + 40, y: box.y + box.height / 2 };
}

test.beforeEach(async ({ page }) => {
  await openApp(page, '/tasks');
  await openTaskSheet(page);
});

test('короткое смещение пальца по шапке панель не двигает', async ({ page }) => {
  const top = await settledTop(page);
  const at = await grip(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x, at.y + 8, { steps: 4 });
  expect(await panel(page).evaluate((el) => el.getBoundingClientRect().top)).toBe(top);
  await page.mouse.up();
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toBeVisible();
});

test('палец, ушедший вбок, шторку не снимает', async ({ page }) => {
  const top = await settledTop(page);
  const at = await grip(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 40, at.y + 6, { steps: 4 });
  await page.mouse.move(at.x + 40, at.y + 180, { steps: 8 });
  expect(await panel(page).evaluate((el) => el.getBoundingClientRect().top)).toBe(top);
  await page.mouse.up();
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toBeVisible();
});

test('протянутая вниз шторка идёт за пальцем без скачка и закрывается', async ({ page }) => {
  const top = await settledTop(page);
  const at = await grip(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x, at.y + 42, { steps: 10 });
  // Порог пройден: панель сдвинута на путь пальца за вычетом 12px порога,
  // а не на весь путь — начала движение с нуля.
  expect(await panel(page).evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(top + 30, 0);
  await page.mouse.move(at.x, at.y + 180, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toHaveCount(0);
});

test('панель не уезжает вбок и не пружинит краями', async ({ page }) => {
  // Владелец (20.09): окно создания задачи двигалось пальцем вправо-влево и
  // «плавало». В headless-движках форма в ширину не вылезает — в iOS её
  // распирает поле даты со своей минимальной шириной, — а сенсорный жест
  // вбок здесь не синтезировать ни колесом (в мобильной эмуляции оно вбок не
  // листает), ни протоколом браузера (отказ «position out of bounds»).
  // Поэтому держим сам запрет, который и соблюдает Safari: вбок панель не
  // листается при любом содержимом, пружины на краях нет. Палец на iPhone —
  // ручная проверка.
  const p = panel(page);
  await p.evaluate((el) => {
    const wide = document.createElement('div');
    wide.style.width = '1200px';
    wide.style.height = '10px';
    el.lastElementChild!.appendChild(wide);
  });
  const style = await p.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { x: cs.overflowX, y: cs.overflowY, ox: cs.overscrollBehaviorX, oy: cs.overscrollBehaviorY };
  });
  expect(style).toEqual({ x: 'hidden', y: 'auto', ox: 'none', oy: 'none' });
});
