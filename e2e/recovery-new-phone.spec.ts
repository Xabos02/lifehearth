import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { openApp, test, WORKER_MATCH } from './fixtures';
import { makeServer } from './syncServer';

// Переезд на новый телефон — весь путь целиком, от включения обмена до
// вернувшихся записей на чистом устройстве.
//
// Это ровно тот случай, из-за которого писался этот тест: у владельца был
// сохранённый ключ и данные на сервере, а пути между ними он из приложения не
// вывел — порядок действий пришлось диктовать голосом. Проверенного круга
// «включил → сохранил ключ → чистое устройство → вставил ключ → мои записи на
// экране» не было ни одного: юниты доходили до записи конфига в базу и на этом
// останавливались.

/** Устройство: свой профиль браузера, свой IndexedDB, общий подставной сервер. */
async function device(ctx: BrowserContext, server: ReturnType<typeof makeServer>): Promise<Page> {
  await ctx.route(WORKER_MATCH, server.handle);
  const page = await ctx.newPage();
  await openApp(page, '/more/settings');
  return page;
}

/** Ключ восстановления так, как его отдаёт приложение. */
async function keyOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { getBackupCode } = await import('/src/lib/sync.ts');
    return (await getBackupCode()) ?? '';
  });
}

async function tasksOf(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.tasks.filter((t) => !t.deletedAt).toArray()).map((t) => t.title).sort();
  });
}

test.describe('переезд на новый телефон', () => {
  test('включил, сохранил ключ, вставил на чистом устройстве — записи вернулись', async ({
    browser,
  }) => {
    const server = makeServer();

    // --- Старый телефон ---
    const ctxA = await browser.newContext();
    const a = await device(ctxA, server);

    await a.getByRole('button', { name: 'Включить синхронизацию' }).click();

    // Первое, что человек видит после включения, — ключ. Раньше здесь
    // открывался «Код для другого устройства», и владелец одного телефона
    // закрывал его не читая.
    await expect(a.getByText('Ключ восстановления', { exact: true })).toBeVisible();

    // Сохранение файла в headless не проверить, но проверяется главное:
    // пока сохранённое не вставлено обратно, ключ не считается сохранённым.
    const key = await keyOf(a);
    expect(key.length).toBeGreaterThan(40);

    await a.getByPlaceholder('Вставьте содержимое файла').fill('не тот текст, который просили');
    await a.getByRole('button', { name: 'Проверить' }).click();
    await expect(a.getByText('Это не тот ключ.', { exact: false })).toBeVisible();

    await a.getByPlaceholder('Вставьте содержимое файла').fill(key);
    await a.getByRole('button', { name: 'Проверить' }).click();
    await expect(a.getByText('Ключ сохранён и проверен')).toBeVisible();

    // Заводим запись и отправляем её на сервер.
    await a.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      const { runSync } = await import('/src/lib/sync.ts');
      const ts = new Date().toISOString();
      await db.tasks.put({
        id: 'task-recovery',
        title: 'Записано на старом телефоне',
        done: false,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
      } as never);
      await runSync();
    });
    expect(server.rows.size).toBeGreaterThan(0);

    // --- Новый телефон: чистый профиль, старого доступа нет ---
    const ctxB = await browser.newContext();
    const b = await device(ctxB, server);

    // Кнопка подключения по ключу — на первом же экране, названная по
    // ситуации человека, а не по устройствам.
    await b.getByRole('button', { name: 'У меня уже есть данные — подключить по ключу' }).click();
    await b.getByText('Вставить ключ').click();
    await b.getByPlaceholder('Вставьте ключ восстановления или код с другого устройства').fill(key);
    await b.getByRole('button', { name: 'Подключить', exact: true }).click();

    await expect
      .poll(async () => (await tasksOf(b)).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(await tasksOf(b)).toContain('Записано на старом телефоне');

    await ctxA.close();
    await ctxB.close();
  });

  test('ключ верный, а данных под ним нет — приложение говорит прямо', async ({ browser }) => {
    // Сервер сменили или базу сбросили. Раньше незнакомый аккаунт
    // регистрировался молча: человек видел «Устройство подключено» и пустое
    // приложение — успех и полная потеря выглядели одинаково.
    const live = makeServer();
    const ctxA = await browser.newContext();
    const a = await device(ctxA, live);
    await a.getByRole('button', { name: 'Включить синхронизацию' }).click();
    await expect(a.getByText('Ключ восстановления', { exact: true })).toBeVisible();
    const key = await keyOf(a);

    const empty = makeServer({ accountExists: false });
    const ctxB = await browser.newContext();
    const b = await device(ctxB, empty);
    await b.getByRole('button', { name: 'У меня уже есть данные — подключить по ключу' }).click();
    await b.getByText('Вставить ключ').click();
    await b.getByPlaceholder('Вставьте ключ восстановления или код с другого устройства').fill(key);
    await b.getByRole('button', { name: 'Подключить', exact: true }).click();

    await expect(b.getByText('Аккаунта с этим ключом на сервере нет', { exact: false })).toBeVisible();
    // И устройство не считает себя подключённым.
    expect(await b.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      return Boolean(await db.sync.get('config'));
    })).toBe(false);

    await ctxA.close();
    await ctxB.close();
  });

  test('пока ключ не сохранён, настройки об этом говорят', async ({ browser }) => {
    const server = makeServer();
    const ctx = await browser.newContext();
    const page = await device(ctx, server);

    await page.getByRole('button', { name: 'Включить синхронизацию' }).click();
    await expect(page.getByText('Ключ восстановления', { exact: true })).toBeVisible();

    // Уходим, не сохранив: приложение обязано переспросить, а потом честно
    // показать состояние «вернуть нечем» вместо зелёного «всё включено».
    page.once('dialog', (d) => void d.accept());
    await page.keyboard.press('Escape');

    await expect(page.getByText('Ключ восстановления не сохранён', { exact: false })).toBeVisible();
    await ctx.close();
  });
});
