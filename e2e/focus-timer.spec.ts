import { test, expect, openApp } from './fixtures';

// Таймер «Фокуса»: идёт и не мешает работать.
//
// Тестов у этого раздела не было ни одного, а его контекст обёрнут вокруг всего
// приложения — поломка здесь роняет каждый экран. Плюс жалоба владельца:
// «дергается экран приложения во время письма продолжительного». Он печатал
// длинный текст, пока шёл сеанс фокуса, и форма под пальцами пересобиралась
// дважды в секунду вместе с тиком.

test('таймер запускается, идёт и виден из другого раздела', async ({ page }) => {
  await openApp(page, '/more/focus');
  await page.getByRole('button', { name: 'Старт' }).click();

  // Мини-таймер появляется поверх любого экрана.
  await page.goto('/tasks');
  const mini = page.getByRole('button', { name: 'Открыть Фокус' });
  await expect(mini).toBeVisible();

  // Время идёт: показание через полторы секунды другое.
  const first = await mini.innerText();
  await page.waitForTimeout(1600);
  const second = await mini.innerText();
  expect(second).not.toBe(first);
});

test('при работающем таймере в задаче можно спокойно писать', async ({ page }) => {
  await openApp(page, '/more/focus');
  await page.getByRole('button', { name: 'Старт' }).click();
  await page.goto('/tasks');

  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  const notes = page.locator('textarea[placeholder="Детали…"]');
  await notes.click();

  // Печатаем длинный текст в несколько строк — как в жалобе.
  for (let i = 1; i <= 4; i++) {
    await notes.type(`${i}. длинный пункт, который не влезает в одну строку экрана телефона`);
    await notes.press('Enter');
  }

  // Ничего не потерялось и не переставилось: нумерация продолжена, заглавные на месте.
  const value = await notes.inputValue();
  expect(value).toContain('1. Длинный пункт');
  expect(value).toContain('5. ');
  // И таймер при этом продолжает идти.
  await expect(page.getByRole('button', { name: 'Открыть Фокус' })).toBeVisible();
});
