import { test, expect, openApp } from './fixtures';

// Список напоминаний идёт по ходу времени.
//
// Владелец: «Надо начинать сначала с прошлого, за сколько, а потом показывать
// настоящее». Раньше список шёл от момента задачи в прошлое: Вовремя → за 5
// мин → … → за неделю, и самый дальний вариант был на дне. Теперь наоборот:
// сверху «за неделю», ниже всё ближе, в конце — сам момент. «Выкл» первым —
// это не точка на шкале, а «напоминания нет».

async function reminderOptions(page: import('@playwright/test').Page) {
  return page.locator('select').filter({ has: page.locator('option', { hasText: 'Выкл' }) })
    .first().locator('option').allInnerTexts()
    // Подписи используют неразрывный пробел («за 5\u00A0мин») — сравниваем как обычный.
    .then((list) => list.map((x) => x.replace(/\u00A0/g, ' ')));
}

test('задача со временем: от «за неделю» к «за 5 мин», в конце «Вовремя»', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toBeVisible();
  await page.getByRole('button', { name: 'Сегодня', exact: true }).click();
  // Время нужно, чтобы появились минутные варианты.
  await page.locator('input[type="time"]').first().fill('12:00');

  const opts = await reminderOptions(page);
  expect(opts[0]).toBe('Выкл');
  expect(opts[1]).toBe('за неделю');
  expect(opts[opts.length - 2]).toBe('за 5 мин');
  expect(opts[opts.length - 1]).toBe('Вовремя');
  // Между ними — строго по убыванию: каждый следующий ближе к сроку.
  expect(opts.slice(1, -1).indexOf('за 1 день')).toBeGreaterThan(opts.slice(1, -1).indexOf('за неделю'));
  expect(opts.slice(1, -1).indexOf('за 15 мин')).toBeGreaterThan(opts.slice(1, -1).indexOf('за 1 ч'));
});

test('задача без времени: от «за неделю» к «за 1 день», в конце «В день задачи»', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toBeVisible();
  await page.getByRole('button', { name: 'Сегодня', exact: true }).click();

  const opts = await reminderOptions(page);
  expect(opts).toEqual(['Выкл', 'за неделю', 'за 3 дня', 'за 2 дня', 'за 1 день', 'В день задачи']);
});
