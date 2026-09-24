import { test, expect, openApp } from './fixtures';

// Оформление: акцентные темы и строка версии в настройках.

test('акцент меняется мгновенно и переживает перезагрузку', async ({ page }) => {
  await openApp(page, '/more/settings');

  const accentOf = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--app-accent').trim(),
    );
  const indigo = await accentOf();

  await page.getByRole('button', { name: /Изумруд/ }).click();
  // Настройка едет асинхронно (Dexie → live-запрос → эффект) — ждём, не меряем сразу.
  await expect.poll(accentOf).not.toBe(indigo);
  const emerald = await accentOf();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.accent))
    .toBe('emerald');

  // Настройка device-local, как тема: живёт в IndexedDB и держится после
  // перезагрузки.
  await page.reload();
  await expect(page.getByRole('button', { name: /Изумруд/ })).toBeVisible();
  await expect.poll(accentOf).toBe(emerald);

  // Возврат к классике — атрибут снимается, токены дефолтные.
  await page.getByRole('button', { name: /Индиго/ }).click();
  await expect.poll(accentOf).toBe(indigo);
  expect(await page.evaluate(() => document.documentElement.dataset.accent)).toBeUndefined();
});

test('строка версии живая и открывает «Что нового»', async ({ page }) => {
  await openApp(page, '/more/settings');
  const versions = await page.evaluate(async () => {
    const { APP_VERSION } = await import('/src/lib/changelog.ts');
    return APP_VERSION;
  });
  // Версия из changelog, не хардкод.
  await expect(page.getByText(`Версия ${versions}`)).toBeVisible();
  await page.getByRole('button', { name: /Что нового/ }).click();
  // Окно открылось — его заголовок. Раньше считались все строки со словами
  // «Что нового» на экране (ждали 2: кнопка + заголовок), и первый же пункт
  // списка изменений с этими словами (1.36.0) делал их три — деплой встал.
  await expect(page.getByRole('heading', { name: 'Что нового', exact: true })).toBeVisible();
});

test('«Что нового» открывается при каждом нажатии и не всплывает само потом', async ({ page }) => {
  // Прогон 13–17.09: второе нажатие «Открыть» ничего не делало, а сброшенная
  // кнопкой версия ('') оставалась в базе — и окно выскакивало само при
  // следующем запуске.
  await openApp(page, '/more/settings');
  const open = page.getByRole('button', { name: /Что нового/ });
  const title = page.getByRole('heading', { name: 'Что нового' });
  const understood = page.getByRole('button', { name: 'Понятно' });

  await open.click();
  await expect(title).toBeVisible();
  await understood.click();
  await expect(title).toHaveCount(0);

  await open.click();
  await expect(title).toBeVisible();
  await understood.click();
  await expect(title).toHaveCount(0);

  // Закрытие записало текущую версию: при следующем запуске окну взяться неоткуда.
  const current = await page.evaluate(async () => (await import('/src/lib/changelog.ts')).APP_VERSION);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts');
        return (await db.settings.get('app'))?.lastSeenVersion;
      }),
    )
    .toBe(current);
});

test('английский язык: включается, переживает перезагрузку, выключается', async ({ page }) => {
  await openApp(page, '/more/settings');
  await page.getByLabel('Язык').selectOption('en');
  // Смена языка перезагружает страницу сама — ждём английский интерфейс.
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Appearance')).toBeVisible();
  // Настройка держится после перезагрузки.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  // Перевод пророс глубже секции «Оформление»: миграция окончена, на этом
  // экране русскому fallback показываться не на чем (саму механику fallback
  // держат юниты i18n.test.ts).
  await expect(page.getByText('Sync', { exact: true })).toBeVisible();
  // Обратно на русский — селект теперь подписан по-английски.
  await page.getByLabel('Language').selectOption('ru');
  await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible({ timeout: 10000 });
});
