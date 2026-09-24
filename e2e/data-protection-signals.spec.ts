import { test, expect, openApp } from './fixtures';

// Напоминания о защите данных — просьбы, а не содержимое: зовут, только когда
// есть о чём, и отпускают, когда обещали.

test('точка «нужна копия» горит, только когда есть что сохранять', async ({ page }) => {
  // Прогон 13–17.09: на только что созданном профиле точка на вкладке
  // «Главная» загоралась через секунду после знакомства — копировать было
  // нечего.
  //
  // Идём от точки к её отсутствию, а не наоборот: точка считается живым
  // запросом, и проверка «нет точки» сразу после открытия прошла бы раньше,
  // чем запрос ответил. Пустая база после очистки — то же состояние, что и
  // новый профиль: копии нет, сохранять нечего. Там же — её пара на «Главной»,
  // строка карточки настроек.
  await openApp(page, '/home');
  const tab = page.locator('nav').last().getByRole('link', { name: /^Главная/ });
  const due = page.getByText('Пора сделать резервную копию');

  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    await db.notes.put({ id: 'n1', title: 'Первая заметка', content: '', createdAt: ts, updatedAt: ts, deletedAt: null } as never);
  });
  await expect(tab).toHaveAccessibleName('Главная, нужна резервная копия');
  await expect(due).toBeVisible();

  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    await db.notes.clear();
  });
  await expect(tab).toHaveAccessibleName('Главная');
  await expect(due).toHaveCount(0);
});

test('«Скрыть» у строки защиты данных держится до следующего запуска, а не до смены вкладки', async ({ page }) => {
  // Прогон 13–17.09 и §12 протокола: «Скрыть» — до следующего запуска. Строка
  // «Данные только на этом устройстве» возвращалась уже после перехода на
  // другую вкладку и обратно.
  await openApp(page, '/');
  const line = page.getByText('Данные только на этом устройстве');
  await expect(line).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Скрыть', exact: true }).click();
  await expect(line).toHaveCount(0);

  const bar = page.locator('nav').last();
  await bar.getByRole('link', { name: /^Задачи/ }).click();
  await expect(page.getByRole('heading', { name: 'Задачи' })).toBeVisible();
  await bar.getByRole('link', { name: /^Сегодня/ }).click();
  // «Сегодня» дочитала базу (пустой день нарисован) — строка к этому моменту
  // уже вернулась бы.
  await expect(page.getByText('На сегодня задач нет')).toBeVisible();
  await expect(line).toHaveCount(0);

  // Новый запуск — строка снова на месте: навсегда её не прячем.
  await page.reload();
  await expect(line).toBeVisible();
});
