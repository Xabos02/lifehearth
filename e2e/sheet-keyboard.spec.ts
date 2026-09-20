import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Шторка — контейнер всех быстрых форм приложения: задача, расход, привычка,
// цель, место, напоминание. На телефоне её нижнюю часть накрывала клавиатура:
// поля и ряд кнопок с «Сохранить» оказывались под ней, и доскроллить туда было
// нельзя — низ самой панели уже под клавиатурой. А привычный жест «тапнуть
// мимо, чтобы убрать клавиатуру» закрывал форму и выбрасывал всё набранное.
//
// Клавиатуры в headless-браузере нет, поэтому подменяем visualViewport: именно
// по нему приложение и считает, сколько пикселей снизу съедено.

const KEYBOARD = 300;

async function fakeViewport(page: Page) {
  await page.addInitScript(() => {
    const target = new EventTarget();
    let height = window.innerHeight;
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      get: () => ({
        get height() {
          return height;
        },
        offsetTop: 0,
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
      }),
    });
    (window as unknown as { showKeyboard: (px: number) => void }).showKeyboard = (px: number) => {
      height = window.innerHeight - px;
      target.dispatchEvent(new Event('resize'));
    };
  });
}

const showKeyboard = (page: Page, px: number) =>
  page.evaluate((n) => (window as unknown as { showKeyboard: (px: number) => void }).showKeyboard(n), px);

/** Открыть форму новой задачи — самая частая шторка приложения. */
async function openTaskSheet(page: Page) {
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toBeVisible();
}

function panel(page: Page) {
  return page.locator('[class*="animate-sheet-up"]');
}

test('панель поднимается над клавиатурой', async ({ page }) => {
  await fakeViewport(page);
  await openApp(page, '/tasks');
  await openTaskSheet(page);

  const before = await panel(page).evaluate((el) => el.getBoundingClientRect().bottom);
  await showKeyboard(page, KEYBOARD);

  await expect
    .poll(async () => panel(page).evaluate((el) => Math.round(el.getBoundingClientRect().bottom)))
    .toBeLessThan(before - KEYBOARD + 10);
});

test('поднятая панель не вылезает за верх экрана — потолок опускается вместе с ней', async ({ page }) => {
  await fakeViewport(page);
  await openApp(page, '/tasks');
  await openTaskSheet(page);
  await showKeyboard(page, KEYBOARD);

  await expect
    .poll(async () => panel(page).evaluate((el) => Math.round(el.getBoundingClientRect().top)))
    .toBeGreaterThanOrEqual(0);
});

test('тап мимо панели при наборе убирает клавиатуру, а не выбрасывает форму', async ({ page }) => {
  await fakeViewport(page);
  await openApp(page, '/tasks');
  await openTaskSheet(page);

  const input = page.locator('textarea[placeholder="Что нужно сделать?"]');
  await input.fill('Забрать колёса в субботу');
  await input.focus();
  await showKeyboard(page, KEYBOARD);

  // Тап в затемнение над панелью.
  await page.mouse.click(10, 10);

  // Форма на месте, текст цел.
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('Забрать колёса в субботу');
  // И фокус снят — то есть на телефоне клавиатура уехала.
  await expect.poll(async () => page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA');
});

test('второй тап мимо панели закрывает форму', async ({ page }) => {
  await fakeViewport(page);
  await openApp(page, '/tasks');
  await openTaskSheet(page);

  const input = page.locator('textarea[placeholder="Что нужно сделать?"]');
  await input.focus();
  await page.mouse.click(10, 10); // снял фокус
  await page.mouse.click(10, 10); // закрыл

  await expect(input).toHaveCount(0);
});
