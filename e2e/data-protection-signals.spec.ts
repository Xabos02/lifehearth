import { test, expect, openApp } from './fixtures';

// Напоминания о защите данных — просьбы, а не содержимое: зовут, только когда
// есть о чём, и отпускают, когда обещали.

test('«Главная» зовёт сделать копию, только когда есть что сохранять — одним правилом везде', async ({ page }) => {
  // Прогон 13–17.09: на только что созданном профиле «Главная» тревожилась
  // через секунду после знакомства — точка на вкладке, «Пора сделать
  // резервную копию» у «Настроек» и оранжевая «Резервную копию ещё не
  // делали» в «Состоянии данных», хотя копировать было нечего. Правило одно на
  // все три места (isBackupDue): копии нет или она старше недели — и есть что
  // сохранять: запись в таблицах копии или заполненный профиль.
  //
  // Строка «Состояния данных» появляется только вместе с ответом своего
  // запроса, поэтому её спокойствие на пустом профиле проверяется сразу. Точку
  // на вкладке считает отдельный запрос — её проверяем переходом «зовёт →
  // отпустила», а не «нет сразу после открытия»: такая проверка прошла бы
  // раньше, чем запрос ответил.
  await openApp(page, '/home');
  const bar = page.getByRole('navigation');
  const tabDue = bar.getByRole('link', { name: 'Главная, нужна резервная копия', exact: true });
  const tabCalm = bar.getByRole('link', { name: 'Главная', exact: true });
  const settingsDue = page.getByText('Пора сделать резервную копию', { exact: true });
  const status = page.getByText('Резервную копию ещё не делали', { exact: true });
  const warning = /(^|\s)text-warning(\s|$)/;

  const expectDue = async () => {
    await expect(tabDue).toBeVisible();
    await expect(settingsDue).toBeVisible();
    await expect(status).toHaveClass(warning);
  };
  const expectCalm = async () => {
    await expect(tabCalm).toBeVisible();
    await expect(settingsDue).toHaveCount(0);
    await expect(status).toBeVisible();
    await expect(status).not.toHaveClass(warning);
  };

  // Пустой профиль: строка на месте — это факт, — но не оранжевая.
  await expect(status).toBeVisible();
  await expect(status).not.toHaveClass(warning);

  // Появилась запись — зовут все три; база снова пуста — отпускают все три.
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    await db.notes.put({ id: 'n1', title: 'Первая заметка', content: '', createdAt: ts, updatedAt: ts, deletedAt: null } as never);
  });
  await expectDue();
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    await db.notes.clear();
  });
  await expectCalm();

  // Заполненный профиль — тоже данные: записей нет, а сохранять уже есть что.
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    await db.settings.update('app', { profile: { name: 'Влад' } });
  });
  await expectDue();
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    await db.settings.update('app', { profile: {} });
  });
  await expectCalm();
});

test('«Скрыть» у строки защиты данных держится до следующего запуска, а не до смены вкладки', async ({ page }) => {
  // Прогон 13–17.09 и §12 протокола: «Скрыть» — до следующего запуска. Строка
  // «Данные только на этом устройстве» возвращалась уже после перехода на
  // другую вкладку и обратно.
  await openApp(page, '/');
  const line = page.getByText('Данные только на этом устройстве', { exact: true });
  await expect(line).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Скрыть', exact: true }).click();
  await expect(line).toHaveCount(0);

  const bar = page.getByRole('navigation');
  await bar.getByRole('link', { name: 'Задачи', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Задачи', exact: true })).toBeVisible();
  await bar.getByRole('link', { name: 'Сегодня', exact: true }).click();
  // «Сегодня» дочитала базу (пустой день нарисован) — строка к этому моменту
  // уже вернулась бы.
  await expect(page.getByText('На сегодня задач нет', { exact: true })).toBeVisible();
  await expect(line).toHaveCount(0);

  // Новый запуск — строка снова на месте: навсегда её не прячем.
  await page.reload();
  await expect(line).toBeVisible();
});
