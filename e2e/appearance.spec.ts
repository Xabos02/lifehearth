import { test, expect, openApp } from './fixtures';

// Оформление: акцент и строка версии в настройках.

// Акцент один — золото (канва design/palette, 05.10.2026). Переключатель
// «Индиго / Изумруд / Закат» убран: экраны и так красились золотом, а выбранный
// цвет доставался только рамке фокуса, свечению под кнопками и галочкам в
// заметках — то есть спорил с золотом. Страж держит обе половины: выбора нет,
// и общий акцент со свечением собраны из золота в обеих темах, а не из
// захардкоженного цвета.
test('акцент один — золото: выбора цвета нет, фокус и свечение золотые', async ({ page }) => {
  await openApp(page, '/more/settings');
  await expect(page.getByRole('button', { name: /Индиго|Изумруд|Закат/ })).toHaveCount(0);

  for (const light of [false, true]) {
    const v = await page.evaluate((light) => {
      document.documentElement.classList.toggle('light', light);
      const cs = getComputedStyle(document.documentElement);
      return {
        accent: cs.getPropertyValue('--app-accent').trim(),
        gold: cs.getPropertyValue('--lh-accent').trim(),
        glow: cs.getPropertyValue('--shadow-accent'),
      };
    }, light);
    expect(v.accent, light ? 'светлая' : 'тёмная').toBe(v.gold);
    expect(v.glow, light ? 'светлая' : 'тёмная').toContain(v.gold);
  }
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
