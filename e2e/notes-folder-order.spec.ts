import { test, expect, openApp, type Page } from './fixtures';

// Порядок папок заметок — удержанием и перетаскиванием внутри уровня.
//
// Владелец: «сделать возможность менять местами по очерёдности папки». До
// 11.09.2026 sortOrder у папки ставился один раз, при создании, и никогда не
// менялся — порядок был порядком создания. Жест — как у папок в Apple Notes
// («коснуться и удерживать папку, затем перетянуть») и как у проектов в
// «Задачах»: та же машина удержания, 400 мс без движения.

async function seed(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.noteFolders.bulkPut([
      { ...base('f1'), name: 'Быт', emoji: '🏠', color: '#5b7cfa', parentId: null, sortOrder: 1757500000001 },
      { ...base('f2'), name: 'Бизнес', emoji: '💼', color: '#f59e0b', parentId: null, sortOrder: 1757500000002 },
      { ...base('f3'), name: 'Здоровье', emoji: '🏃', color: '#10b981', parentId: null, sortOrder: 1757500000003 },
    ] as never[]);
  });
  await page.reload();
  await expect(page.getByText('Здоровье', { exact: true })).toBeVisible();
}

async function order(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.noteFolders.toArray()).sort((a, b) => a.sortOrder - b.sortOrder).map((f) => f.name);
  });
}

async function hold(page: Page, name: string) {
  const el = page.getByText(name, { exact: true }).first();
  const box = (await el.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.waitForTimeout(500); // порог удержания 400 мс
  return at;
}

test('папку можно перетащить наверх — порядок в базе меняется', async ({ page }) => {
  await openApp(page, '/notes');
  await seed(page);
  expect(await order(page)).toEqual(['Быт', 'Бизнес', 'Здоровье']);

  const from = await hold(page, 'Здоровье');
  const target = (await page.getByText('Быт', { exact: true }).first().boundingBox())!;
  await page.mouse.move(from.x, target.y + 4, { steps: 10 });
  await page.mouse.up();

  await expect.poll(() => order(page)).toEqual(['Здоровье', 'Быт', 'Бизнес']);
  // Ровные шаги — следующей перестановке есть куда встать.
  const values = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.noteFolders.toArray()).sort((a, b) => a.sortOrder - b.sortOrder).map((f) => f.sortOrder);
  });
  expect(values).toEqual([1000, 2000, 3000]);
});

test('удержание без движения ничего не меняет, обычный тап открывает папку', async ({ page }) => {
  await openApp(page, '/notes');
  await seed(page);
  const before = await order(page);

  await hold(page, 'Бизнес');
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(await order(page)).toEqual(before);
  // Папка не открылась — удержание не тап.
  await expect(page.getByRole('heading', { name: /Бизнес/ })).toHaveCount(0);

  await page.getByText('Бизнес', { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: /Бизнес/ })).toBeVisible();
});
