import { test, expect, openApp } from './fixtures';

// Знакомство: назад по слайдам — кнопкой и свайпом.
//
// Владелец: «нету возможности вернуться на предыдущий слайд». Точки внизу
// были кликабельны, но как кнопки их никто не читает. Теперь на всех шагах,
// кроме первого, слева стоит «Назад», а свайп вправо/влево листает слайды.

const overlay = (page: import('@playwright/test').Page) => page.locator('.fixed.z-\\[80\\]');

async function openFresh(page: import('@playwright/test').Page) {
  // Гейт первого запуска пройден, а знакомство — нет: так оно показывается само.
  await openApp(page, '/');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const prev = (await db.settings.get('app')) ?? { id: 'app' };
    await db.settings.put({ ...prev, onboardingDone: null });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Далее' })).toBeVisible();
}

test('«Назад» появляется со второго шага и возвращает на предыдущий', async ({ page }) => {
  await openFresh(page);
  const first = await overlay(page).locator('h2').innerText();
  await expect(page.getByRole('button', { name: 'Назад' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Пропустить' })).toBeVisible();

  await page.getByRole('button', { name: 'Далее' }).click();
  const second = await overlay(page).locator('h2').innerText();
  expect(second).not.toBe(first);
  await expect(page.getByRole('button', { name: 'Назад' })).toBeVisible();

  await page.getByRole('button', { name: 'Назад' }).click();
  await expect(overlay(page).locator('h2')).toHaveText(first);
});

test('свайп листает слайды в обе стороны', async ({ page }) => {
  await openFresh(page);
  const first = await overlay(page).locator('h2').innerText();
  const box = (await overlay(page).locator('h2').boundingBox())!;
  const y = box.y + box.height / 2;

  // Влево — вперёд.
  await page.mouse.move(300, y);
  await page.mouse.down();
  await page.mouse.move(120, y, { steps: 8 });
  await page.mouse.up();
  const second = await overlay(page).locator('h2').innerText();
  expect(second).not.toBe(first);

  // Вправо — назад.
  await page.mouse.move(100, y);
  await page.mouse.down();
  await page.mouse.move(300, y, { steps: 8 });
  await page.mouse.up();
  await expect(overlay(page).locator('h2')).toHaveText(first);
});

test('«восстановить» видно на первом экране — переезжающему не надо листать', async ({ page }) => {
  await openFresh(page);
  const restore = page.getByRole('button', { name: 'У меня уже были данные — восстановить' });
  await expect(restore).toBeVisible();
  // На среднем слайде строка спрятана, чтобы не сбивать знакомство.
  await page.getByRole('button', { name: 'Далее' }).click();
  await expect(restore).not.toBeVisible();
});

test('на первом слайде иконка приложения крупно, дальше — своя картинка на каждом', async ({ page }) => {
  await openFresh(page);
  // Иконка — та, что человек только что поставил на «Домой», и не плитка 80px.
  const icon = overlay(page).locator('img.onb-app-icon');
  await expect(icon).toBeVisible();
  const box = (await icon.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(150);
  await expect(icon).toHaveJSProperty('naturalWidth', 192);

  // Каждый следующий слайд — свой рисунок, а не одна плитка на всех.
  const seen = new Set<string>();
  for (let i = 0; i < 7; i++) {
    await page.getByRole('button', { name: 'Далее' }).click();
    const illo = overlay(page).locator('svg.onb-illo');
    await expect(illo).toBeVisible();
    seen.add(await illo.innerHTML());
  }
  expect(seen.size).toBe(7);
});
