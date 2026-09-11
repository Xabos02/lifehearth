import { test, expect, openApp } from './fixtures';

// «+» у заголовка проекта — добавить задачу, не листая до низа.
//
// Владелец: «когда много задач, мне приходится листать в самый низ, чтобы
// добавить задачу в этот проект». Кнопка стоит рядом с карандашом и открывает
// форму уже с выбранным проектом.

async function seed(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    await db.projects.bulkPut([
      { id: 'p1', name: 'Бизнес', color: '#5b7cfa', emoji: '📁', parentId: null, sortOrder: 1, archivedAt: null, createdAt: ts, updatedAt: ts, deletedAt: null },
      { id: 'p2', name: 'Разработка', color: '#ef4444', emoji: '📁', parentId: 'p1', sortOrder: 2, archivedAt: null, createdAt: ts, updatedAt: ts, deletedAt: null },
    ] as never[]);
  });
  await page.reload();
  await expect(page.getByText('Разработка')).toBeVisible();
}

test('«+» у проекта открывает форму с этим проектом', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);

  await page.getByRole('button', { name: 'Добавить задачу в проект' }).first().click();
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toBeVisible();
  await page.locator('textarea[placeholder="Что нужно сделать?"]').fill('Позвонить поставщику');
  await page.getByRole('button', { name: 'Сохранить' }).click();

  const saved = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const t = (await db.tasks.toArray()).find((x: { title: string }) => x.title === 'Позвонить поставщику');
    return t?.projectId;
  });
  expect(saved).toBe('p1');
});

test('«+» у подпроекта кладёт задачу в подпроект', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);

  await page.getByRole('button', { name: 'Добавить задачу в подпроект' }).first().click();
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toBeVisible();
  await page.locator('textarea[placeholder="Что нужно сделать?"]').fill('Собрать сборку');
  await page.getByRole('button', { name: 'Сохранить' }).click();

  const saved = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const t = (await db.tasks.toArray()).find((x: { title: string }) => x.title === 'Собрать сборку');
    return t?.projectId;
  });
  expect(saved).toBe('p2');
});
