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

// Длинная форма (шаблон тренировки на десять упражнений): поле в фокусе стоит
// у нижнего края панели. Клавиатура срезает панель снизу на свою высоту —
// поле оставалось под краем: печатаешь и не видишь (находка 15.11.2026).
test('поле в фокусе у нижнего края длинной формы остаётся над клавиатурой', async ({ page }) => {
  await fakeViewport(page);
  await openApp(page, '/more/health');
  await page.evaluate(async () => {
    const { addTemplate } = await import('/src/features/health/templateRepo.ts');
    const exercises = Array.from({ length: 10 }, (_, i) => ({ name: `Упражнение ${i + 1}`, sets: 3, reps: 10, note: 'Пометка' }));
    await addTemplate({ name: 'Длинный', items: [{ type: 'strength', customLabel: null, customColor: null, minutes: 0, distanceKm: null, exercises }] } as never);
  });
  await page.getByTestId('day-templates').getByRole('button', { name: 'Шаблоны', exact: true }).click();
  await page.getByRole('button', { name: 'Изменить шаблон «Длинный»' }).click();
  await page.getByTestId('exercise-row').last().click();
  const note = page.getByTestId('exercise-editor').getByLabel('Заметка');
  // Поле — к самому низу видимой части панели, как после прокрутки пальцем.
  await note.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await note.focus();
  await showKeyboard(page, KEYBOARD);
  await expect
    .poll(async () => note.evaluate((el) => Math.round(el.getBoundingClientRect().bottom)))
    .toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) - KEYBOARD);
});

