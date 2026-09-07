import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Пока открыта форма, экран под ней стоит на месте.
//
// Панель формы прокручивается сама, и без запрета прокрутка, дойдя до её края,
// перетекала на страницу ПОД ней: список задач уезжал вместе с формой, а после
// закрытия оказывался не там, где его оставили. Со стороны это выглядит как
// «плавает весь экран» — и объяснить это невозможно, потому что двигается не
// то, чего касается палец.
//
// Пути перетекания два, и закрыты оба: сама панель (overscroll-contain) и всё
// мимо неё — подложка, инерция, колесо над краем (контейнер приложения
// заморожен на время формы).

const SCROLLER = '[data-app-scroll]';

async function seedMany(page: Page, n: number) {
  await page.evaluate(async (n) => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Дела', color: '#5b7cfa', emoji: '📁', sortOrder: 1000, archivedAt: null },
    ]);
    await db.tasks.bulkPut(
      Array.from({ length: n }, (_, i) => ({
        ...base(`t${i}`), title: `Задача ${i}`, notes: '', projectId: 'p1', goalId: null,
        priority: 0, dueDate: null, dueTime: null, duration: null, remindBefore: null,
        completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: (i + 1) * 1000,
      })) as never[],
    );
  }, n);
  await page.goto('/tasks');
  await expect(page.getByText('Задача 0')).toBeVisible();
}

async function scrollTop(page: Page) {
  return page.locator(SCROLLER).evaluate((el) => el.scrollTop);
}

test('прокрутка внутри формы не уводит список под ней', async ({ page }) => {
  await openApp(page, '/tasks');
  await seedMany(page, 40);

  // Отматываем список, чтобы было куда «уезжать» в обе стороны.
  await page.locator(SCROLLER).evaluate((el) => {
    el.scrollTop = 300;
  });
  const before = await scrollTop(page);
  expect(before, 'списку негде прокручиваться — проверка была бы пустой').toBeGreaterThan(0);

  await page.getByText('Задача 0', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /Задача|Правка/ })).toBeVisible();

  // Крутим колесом над формой в обе стороны, с запасом за её края.
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 400);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -400);

  expect(await scrollTop(page), 'список под формой уехал').toBe(before);
});

test('после закрытия формы список остаётся там, где его оставили', async ({ page }) => {
  await openApp(page, '/tasks');
  await seedMany(page, 40);

  await page.locator(SCROLLER).evaluate((el) => {
    el.scrollTop = 260;
  });
  const before = await scrollTop(page);

  await page.getByText('Задача 0', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /Задача|Правка/ })).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByRole('heading', { name: /Задача|Правка/ })).toHaveCount(0);

  expect(await scrollTop(page)).toBe(before);
});
