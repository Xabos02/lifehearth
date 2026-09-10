import { test, expect, openApp } from './fixtures';

// Пустое поле срока должно выглядеть пустым.
//
// Случай владельца: он открыл новую задачу, увидел в поле «Срок» сегодняшнее
// число и решил, что срок уже стоит. Нажал «Убрать» — ничего не изменилось,
// и это выглядело как поломка. На деле срок не стоял: так WebKit рисует
// НЕЗАПОЛНЕННОЕ поле даты — подставляет текущую дату вместо подсказки формата.
// Убирать было нечего.

test('у новой задачи срок не задан, и поле говорит об этом словом', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  // Дожидаемся самой формы: на движке Safari шит открывается заметно
  // медленнее, и проверка успевала прийти раньше него.
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toBeVisible();

  const due = page.locator('input[type="date"]').first();
  await expect(due).toHaveValue('');
  // Ни один чип не подсвечен — срока действительно нет.
  await expect(page.getByRole('button', { name: 'Сегодня', exact: true })).not.toHaveClass(/bg-accent/);
  // И человек видит это словом, а не гадает по бледным цифрам.
  await expect(page.getByText('Не задан')).toBeVisible();
  // Нативный текст поля при этом не виден — иначе слово легло бы на цифры.
  const color = await due.evaluate((el) => getComputedStyle(el).color);
  expect(color).toBe('rgba(0, 0, 0, 0)');
});

test('заданный срок показывается цифрами, а «Убрать» его снимает', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  // Дожидаемся самой формы: на движке Safari шит открывается заметно
  // медленнее, и проверка успевала прийти раньше него.
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toBeVisible();

  await page.getByRole('button', { name: 'Сегодня', exact: true }).click();
  const due = page.locator('input[type="date"]').first();
  await expect(due).not.toHaveValue('');
  await expect(page.getByText('Не задан')).toHaveCount(0);

  await page.getByRole('button', { name: 'Убрать', exact: true }).click();
  await expect(due).toHaveValue('');
  await expect(page.getByText('Не задан')).toBeVisible();
});
