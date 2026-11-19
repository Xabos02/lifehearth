import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Экран «Настроить разделы»: единый список вместо трёх зон.
// Тумблер — включает/выключает раздел нажатием, перенос — удержанием строки.

/** Живая привычка на сегодня — сид для проверки «скрытый раздел молчит».
 *  schedule: daily, чтобы isPlannedOn(...) была true при любой дате теста. */
async function seedHabit(page: Page, id = 'h1', name = 'Отжимания') {
  await page.evaluate(
    async ({ id, name }) => {
      const { db } = await import('/src/db/db.ts');
      const now = new Date().toISOString();
      await db.habits.clear();
      await db.habits.put({
        id,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        name,
        emoji: '💪',
        color: '#5b7cfa',
        schedule: { type: 'daily' },
        target: null,
        unit: '',
        goalId: null,
        archivedAt: null,
        sortOrder: 1000,
      });
    },
    { id, name },
  );
}

/** Тумблер строки раздела на экране настройки. */
function toggleFor(page: Page, label: string) {
  return page.getByRole('button', { name: new RegExp(`(Выключить|Включить) раздел ${label}$`) });
}

/** Удержание строки до старта переноса — как в TasksPage: таймер долгого
 *  нажатия, факт старта подтверждается плашкой-призраком под пальцем. */
async function hold(page: Page, label: string) {
  const el = page.locator('[data-zone="enabled"]').getByText(label, { exact: true }).first();
  await el.scrollIntoViewIfNeeded();
  await el.hover();
  await page.mouse.down();
  await expect(page.locator('.fixed.z-\\[70\\]'), 'перенос не стартовал — плашки нет').toBeVisible({
    timeout: 2000,
  });
  return el;
}

test.describe('тумблер', () => {
  test('выключает раздел — он пропадает из «Главной» и оседает в «Выключено»', async ({ page }) => {
    await openApp(page, '/more/settings/sections');
    const enabledZone = page.locator('[data-zone="enabled"]');
    await expect(enabledZone.getByText('Привычки', { exact: true })).toBeVisible();
    // До нажатия «Привычек» среди выключенных нет.
    const hiddenZoneBefore = page.locator('[data-zone="hidden"]');
    await expect(hiddenZoneBefore.getByText('Привычки', { exact: true })).toHaveCount(0);

    await toggleFor(page, 'Привычки').click();

    // ушёл из включённых...
    await expect(enabledZone.getByText('Привычки', { exact: true })).toHaveCount(0);
    // ...и осел в приглушённой группе «Выключено» этого же экрана.
    const hiddenZone = page.locator('[data-zone="hidden"]');
    await expect(page.getByText('Выключено')).toBeVisible();
    await expect(hiddenZone.getByText('Привычки', { exact: true })).toBeVisible();

    // автосохранение долетело до settings — «Главная» больше не предлагает раздел.
    await page.waitForTimeout(300);
    await page.goto('/home');
    await expect(page.getByText('Привычки', { exact: true })).toHaveCount(0);

    // включить обратно — тумблер работает и в другую сторону.
    await page.goto('/more/settings/sections');
    await toggleFor(page, 'Привычки').click();
    await expect(page.locator('[data-zone="enabled"]').getByText('Привычки', { exact: true })).toBeVisible();
  });

  test('«Сегодня» и «Настройки» нельзя выключить — вместо тумблера бейдж «всегда»', async ({ page }) => {
    await openApp(page, '/more/settings/sections');
    await expect(toggleFor(page, 'Сегодня')).toHaveCount(0);
    await expect(toggleFor(page, 'Настройки')).toHaveCount(0);
    const zone = page.locator('[data-zone="enabled"]');
    await expect(zone.getByText('Сегодня', { exact: true })).toBeVisible();
    await expect(zone.getByText('Настройки', { exact: true })).toBeVisible();
  });
});

test.describe('скрытый раздел молчит', () => {
  test('блок «Привычки» на «Сегодня» виден при включённом разделе и исчезает при выключенном', async ({
    page,
  }) => {
    await openApp(page, '/');
    await seedHabit(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Привычки' })).toBeVisible();
    await expect(page.getByText('Отжимания', { exact: true })).toBeVisible();

    await page.goto('/more/settings/sections');
    await toggleFor(page, 'Привычки').click();
    await page.waitForTimeout(300); // автосохранение в Dexie — асинхронное

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Привычки' })).toHaveCount(0);
    await expect(page.getByText('Отжимания', { exact: true })).toHaveCount(0);
  });
});

test.describe('удержание и перенос', () => {
  test('перенос строки выше черты кладёт раздел в нижнюю панель, вытесняя четвёртый', async ({ page }) => {
    await openApp(page, '/more/settings/sections');

    // Исходно панель — «Сегодня, Задачи, Заметки, Семья» (редизайн), а
    // «Календарь» — в списке раздела «Ещё», под чертой.
    const bar = page.locator('nav').last();
    await expect(bar.getByRole('link', { name: /^Семья/ })).toBeVisible();
    await expect(bar.getByRole('link', { name: /Календарь/ })).toHaveCount(0);

    await hold(page, 'Календарь');
    const today = page.locator('[data-zone="enabled"]').getByText('Сегодня', { exact: true }).first();
    const box = (await today.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y - 4, { steps: 6 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(300);

    // «Календарь» встал первым в панели, а «Семья» — вытеснена под черту, в
    // список «Ещё»: в панели по-прежнему ровно MAX_BOTTOM разделов.
    await expect(bar.getByRole('link', { name: /Календарь/ })).toBeVisible();
    await expect(bar.getByRole('link', { name: /^Семья/ })).toHaveCount(0);

    // Полная перезагрузка: вытеснение обязано пережить рестарт, а не жить
    // только в состоянии открытого экрана.
    await page.goto('/home');
    const barAfterReload = page.locator('nav').last();
    await expect(barAfterReload.getByRole('link', { name: /Календарь/ })).toBeVisible();
    await expect(barAfterReload.getByRole('link', { name: /^Семья/ })).toHaveCount(0);
    await expect(page.locator('main').getByText('Семья', { exact: true }).first()).toBeVisible();
  });
});
