import { test, expect, openApp } from './fixtures';

// Создание проекта — то, чего в наборе тестов не было вовсе.
test('новый проект создаётся и появляется в списке', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await openApp(page, '/tasks');
  // Кнопка «Новый проект» есть только когда на экране уже что-то есть —
  // сеем один проект, чтобы попасть в состояние владельца.
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    await db.projects.put({
      id: 'p-seed', name: 'Быт', color: '#5b7cfa', emoji: '📁', parentId: null,
      sortOrder: 1, archivedAt: null, createdAt: ts, updatedAt: ts, deletedAt: null,
    } as never);
  });
  await page.reload();
  await expect(page.getByText('Быт')).toBeVisible();
  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByPlaceholder('Например, «Ремонт»').fill('Ремонт кухни');
  await page.getByRole('button', { name: 'Сохранить' }).click();

  await expect(page.getByRole('heading', { name: 'Ремонт кухни' })).toBeVisible({ timeout: 5000 });
  const saved = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.projects.toArray()).map((p: { name: string }) => p.name);
  });
  expect(saved).toContain('Ремонт кухни');
  expect(errors).toEqual([]);
});

test('подпроект создаётся внутри проекта', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await openApp(page, '/tasks');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    await db.projects.put({
      id: 'p-seed', name: 'Быт', color: '#5b7cfa', emoji: '📁', parentId: null,
      sortOrder: 1, archivedAt: null, createdAt: ts, updatedAt: ts, deletedAt: null,
    } as never);
  });
  await page.reload();
  await page.getByRole('button', { name: 'Подпроект' }).first().click();
  await page.getByPlaceholder('Например, «Ремонт»').fill('Кухня');
  await page.getByRole('button', { name: 'Сохранить' }).click();

  const saved = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.projects.toArray()).map((p: { name: string; parentId: string | null }) =>
      `${p.name}:${p.parentId ?? 'корень'}`);
  });
  expect(saved).toContain('Кухня:p-seed');
  expect(errors).toEqual([]);
});
