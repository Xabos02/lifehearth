import { test, expect, openApp } from './fixtures';

// Заглавная буква в начале строки и пункта — в форме задачи.
//
// Случай владельца дословно: он перечисляет по пунктам, жмёт Enter, приложение
// само продолжает нумерацию — а первое слово нового пункта остаётся со
// строчной. Клавиатура iOS тут не помощник: она поднимает регистр после точки,
// а в списке точек нет.
//
// Печатаем по-настоящему (type, а не fill): правило живёт в обработчике ввода,
// и fill его не вызывает вовсе — тест бы позеленел на сломанном коде.

test('нумерация продолжается, и следующий пункт начинается с заглавной', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();

  const notes = page.locator('textarea[placeholder="Детали…"]');
  await notes.click();
  await notes.type('1. поправить иконки');
  await notes.press('Enter');
  await notes.type('проверить на телефоне');

  // Нумерация продолжена приложением, а первая буква пункта поднята.
  await expect(notes).toHaveValue('1. Поправить иконки\n2. Проверить на телефоне');
});

test('в середине строки регистр не трогаем', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();

  const notes = page.locator('textarea[placeholder="Детали…"]');
  await notes.click();
  await notes.type('купить и т.д. потом');

  await expect(notes).toHaveValue('Купить и т.д. потом');
});

test('название задачи тоже начинается с заглавной', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();

  const title = page.locator('textarea[placeholder="Что нужно сделать?"]');
  await title.click();
  await title.type('позвонить в сервис');

  await expect(title).toHaveValue('Позвонить в сервис');
});
