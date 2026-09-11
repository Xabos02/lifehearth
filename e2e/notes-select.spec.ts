import { test, expect, openApp } from './fixtures';

// Заметки: выбрать несколько или все, переместить и удалить группой.
//
// Владелец: «выбирать несколько или все сразу заметки в папке или без папок,
// чтобы можно было переместить, удалить». Приёмы — из Apple Notes по
// официальной документации: вход в выбор кнопкой в шапке («More → Select
// Notes»), тап по заметке — отметка, действия «Переместить» и «Удалить».
// Удержание в этом списке по-прежнему переносит одну заметку — жест не тронут.

async function seed(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    await db.noteFolders.put({ id: 'f1', name: 'Быт', emoji: '🏠', color: '#5b7cfa', parentId: null, sortOrder: 1000, createdAt: ts, updatedAt: ts, deletedAt: null } as never);
    await db.notes.bulkPut([
      { id: 'n1', createdAt: ts, updatedAt: ts, deletedAt: null, title: 'Покупки', content: '<p>Покупки</p>', tags: [], pinned: false, folderId: null },
      { id: 'n2', createdAt: ts, updatedAt: ts, deletedAt: null, title: 'Идеи', content: '<p>Идеи</p>', tags: [], pinned: false, folderId: null },
      { id: 'n3', createdAt: ts, updatedAt: ts, deletedAt: null, title: 'Книги', content: '<p>Книги</p>', tags: [], pinned: false, folderId: null },
      { id: 'n4', createdAt: ts, updatedAt: ts, deletedAt: null, title: 'В папке', content: '<p>В папке</p>', tags: [], pinned: false, folderId: 'f1' },
    ] as never[]);
  });
  await page.reload();
  await expect(page.getByText('Покупки')).toBeVisible();
}

const rowOf = (page: import('@playwright/test').Page, title: string) =>
  page.getByRole('checkbox').filter({ hasText: title });

async function idsWhere(page: import('@playwright/test').Page, pred: string) {
  return page.evaluate(async (p) => {
    const { db } = await import('/src/db/db.ts');
    const all = await db.notes.toArray();
    // eslint-disable-next-line no-new-func
    const f = new Function('n', `return ${p}`) as (n: unknown) => boolean;
    return all.filter(f).map((n: { id: string }) => n.id).sort();
  }, pred);
}

test('вне режима тап открывает заметку; «Выбрать» включает отметки', async ({ page }) => {
  await openApp(page, '/notes');
  await seed(page);
  await expect(page.getByRole('checkbox')).toHaveCount(0);

  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Выбрано: 0' })).toBeVisible();
  await expect(page.getByTestId('notes-select-bar')).toBeVisible();
  // Кнопка «+» уступила место панели.
  await expect(page.getByRole('button', { name: 'Добавить', exact: true })).toHaveCount(0);

  await rowOf(page, 'Покупки').click();
  await expect(page.getByRole('heading', { name: 'Выбрано: 1' })).toBeVisible();
  await expect(rowOf(page, 'Покупки')).toHaveAttribute('aria-checked', 'true');
  // Тап по отмеченной — снять; и заметка при этом не открылась.
  await rowOf(page, 'Покупки').click();
  await expect(rowOf(page, 'Покупки')).toHaveAttribute('aria-checked', 'false');
  await expect(page).toHaveURL(/\/notes$/);

  await page.getByRole('button', { name: 'Готово' }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
});

test('«Выбрать все» берёт только текущий уровень и превращается в «Снять выбор»', async ({ page }) => {
  await openApp(page, '/notes');
  await seed(page);
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await page.getByRole('button', { name: 'Выбрать все' }).click();
  // В корне три заметки; четвёртая лежит в папке и в выбор не попадает.
  await expect(page.getByRole('heading', { name: 'Выбрано: 3' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Снять выбор' })).toBeVisible();
  await page.getByRole('button', { name: 'Снять выбор' }).click();
  await expect(page.getByRole('heading', { name: 'Выбрано: 0' })).toBeVisible();
});

test('группа переезжает в папку через «Куда перенести?»', async ({ page }) => {
  await openApp(page, '/notes');
  await seed(page);
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await rowOf(page, 'Покупки').click();
  await rowOf(page, 'Идеи').click();
  await page.getByRole('button', { name: 'Переместить (2)' }).click();

  await expect(page.getByRole('heading', { name: 'Куда перенести?' })).toBeVisible();
  await expect(page.getByText('2 заметки — выберите папку.')).toBeVisible();
  await page.getByRole('button', { name: /Быт/ }).click();

  // Перенос идёт по одной записи и завершается после того, как клик вернулся.
  await expect.poll(() => idsWhere(page, "n.folderId === 'f1' && !n.deletedAt")).toEqual(['n1', 'n2', 'n4']);
  // Вышли из режима, третья осталась в корне.
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByText('Книги')).toBeVisible();
  await expect(page.getByText('Покупки')).toHaveCount(0);
});

test('группа удаляется в Корзину одним подтверждением', async ({ page }) => {
  await openApp(page, '/notes');
  await seed(page);
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await rowOf(page, 'Покупки').click();
  await rowOf(page, 'Книги').click();

  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); void d.accept(); });
  await page.getByRole('button', { name: 'Удалить (2)' }).click();

  await expect(page.getByText('Покупки')).toHaveCount(0);
  await expect(page.getByText('Книги')).toHaveCount(0);
  await expect(page.getByText('Идеи')).toBeVisible();
  expect(asked).toContain('2 заметки');
  // Мягко: записи с deletedAt, восстанавливаются из Корзины.
  await expect.poll(() => idsWhere(page, 'Boolean(n.deletedAt)')).toEqual(['n1', 'n3']);
});

test('смена уровня снимает выбор сама', async ({ page }) => {
  await openApp(page, '/notes');
  await seed(page);
  await page.getByRole('button', { name: 'Выбрать', exact: true }).click();
  await rowOf(page, 'Покупки').click();
  await expect(page.getByRole('heading', { name: 'Выбрано: 1' })).toBeVisible();
  // Зашли в папку — режима нет, отметок нет.
  await page.getByRole('button', { name: /Быт/ }).click();
  await expect(page.getByText('В папке')).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
});
