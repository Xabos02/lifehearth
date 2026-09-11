import { test, expect, openApp } from './fixtures';

// Перенос проекта в другой проект через форму — вместе с его подпроектами.
//
// Владелец: «сделать возможность проект, даже если у проекта есть подпроект,
// прикрепить к другому проекту — и тогда он должен стать подпроектом». Форма
// раньше отвечала «есть подпроекты — нельзя»; теперь правила дерева
// (projectTree.ts): не в себя, не в потомка, и не глубже трёх уровней.

async function seed(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    await db.projects.bulkPut([
      { id: 'A', name: 'Бизнес', color: '#5b7cfa', emoji: '📁', parentId: null, sortOrder: 1, archivedAt: null, createdAt: ts, updatedAt: ts, deletedAt: null },
      { id: 'B', name: 'Поставщики', color: '#f59e0b', emoji: '📁', parentId: 'A', sortOrder: 2, archivedAt: null, createdAt: ts, updatedAt: ts, deletedAt: null },
      { id: 'D', name: 'Здоровье', color: '#10b981', emoji: '📁', parentId: null, sortOrder: 3, archivedAt: null, createdAt: ts, updatedAt: ts, deletedAt: null },
    ] as never[]);
  });
  await page.reload();
  await expect(page.getByText('Поставщики')).toBeVisible();
}

test('проект с подпроектом переезжает через форму, подпроект едет следом', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);

  await page.getByRole('button', { name: 'Редактировать проект' }).first().click();
  const select = page.locator('select').filter({ has: page.locator('option', { hasText: 'Верхний уровень' }) });
  await expect(select).toBeVisible();
  // В списке родителей нет самого «Бизнеса» и нет его потомка «Поставщиков».
  const options = await select.locator('option').allInnerTexts();
  expect(options.join(' ')).not.toContain('Бизнес');
  expect(options.join(' ')).not.toContain('Поставщики');
  expect(options.join(' ')).toContain('Здоровье');

  await select.selectOption({ label: options.find((o) => o.includes('Здоровье'))! });
  await page.getByRole('button', { name: 'Сохранить' }).click();

  const after = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return {
      business: (await db.projects.get('A'))?.parentId ?? null,
      suppliers: (await db.projects.get('B'))?.parentId ?? null,
    };
  });
  expect(after).toEqual({ business: 'D', suppliers: 'A' });
  // Три уровня на экране: Здоровье → Бизнес → Поставщики.
  await expect(page.getByText('Поставщики')).toBeVisible();
});

test('в подпроект третьего уровня новый подпроект не предлагается', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);
  // Делаем три уровня: Здоровье → Бизнес → Поставщики.
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    await db.projects.update('A', { parentId: 'D' });
  });
  await page.reload();
  await expect(page.getByText('Поставщики')).toBeVisible();

  // У «Поставщиков» (третий уровень) кнопки «Подпроект» нет — глубже нельзя.
  const suppliersBlock = page.locator('[data-drop-key="B"]');
  await expect(suppliersBlock.getByRole('button', { name: 'Добавить подпроект' })).toHaveCount(0);
  // А у «Бизнеса» (второй уровень) — есть.
  const businessBlock = page.locator('[data-drop-key="A"]');
  await expect(businessBlock.getByRole('button', { name: 'Добавить подпроект' }).first()).toBeVisible();
});
