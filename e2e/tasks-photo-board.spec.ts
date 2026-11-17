import type { Page } from '@playwright/test';
import { expect, openApp, test } from './fixtures';

// Фотопанель наверху «Задач» (16.11.2026): одно фото — во всю ширину, чем
// больше фото, тем мельче, снимок виден целиком; убирается из просмотра после
// подтверждения.

const BOARD = 'section[aria-label="Фотопанель"]';

/** Настоящий PNG заданного размера — рисуем в странице, отдаём байтами. */
async function png(page: Page, w: number, h: number, color: string): Promise<Buffer> {
  const b64 = await page.evaluate(
    ({ w, h, color }) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
      return c.toDataURL('image/png').split(',')[1];
    },
    { w, h, color },
  );
  return Buffer.from(b64, 'base64');
}

async function addPhotos(page: Page, files: Array<{ name: string; buffer: Buffer }>) {
  await page
    .locator('input[type="file"][accept="image/*"]')
    .first()
    .setInputFiles(files.map((f) => ({ ...f, mimeType: 'image/png' })));
}

test('фото на панели: одно во всю ширину, несколько — мельче и в границах', async ({ page }) => {
  await openApp(page, '/tasks');
  await expect(page.locator(BOARD)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Добавить фото на панель' })).toBeVisible();

  await addPhotos(page, [{ name: 'a.png', buffer: await png(page, 800, 600, '#3b6') }]);
  const tiles = page.locator(`${BOARD} button`);
  await expect(tiles).toHaveCount(1);

  const main = (await page.locator(BOARD).boundingBox())!;
  const one = (await tiles.first().boundingBox())!;
  // Во всю ширину колонки и в пропорциях снимка 4:3 — без обрезки.
  expect(Math.abs(one.width - main.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(one.width / one.height - 4 / 3)).toBeLessThan(0.02);

  await addPhotos(page, [
    { name: 'b.png', buffer: await png(page, 600, 800, '#36b') },
    { name: 'c.png', buffer: await png(page, 1200, 675, '#b63') },
    { name: 'd.png', buffer: await png(page, 700, 700, '#b3b') },
  ]);
  await expect(tiles).toHaveCount(4);
  const board = (await page.locator(`${BOARD} > div`).boundingBox())!;
  let smallest = Infinity;
  for (const box of await Promise.all((await tiles.all()).map((t) => t.boundingBox()))) {
    expect(box!.x).toBeGreaterThanOrEqual(board.x - 0.5);
    expect(box!.x + box!.width).toBeLessThanOrEqual(board.x + board.width + 0.5);
    expect(box!.y + box!.height).toBeLessThanOrEqual(board.y + board.height + 0.5);
    // Плитка — кнопка: не меньше зоны касания.
    expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
    smallest = Math.min(smallest, box!.width * box!.height);
  }
  // Мельче, чем одно фото, — но не марки.
  expect(smallest).toBeLessThan(one.width * one.height);
  expect(board.height).toBeLessThanOrEqual(Math.min(Math.round(board.width * 0.75), 320));
});

test('фото убирается из просмотра после подтверждения, содержимое убранного стирается', async ({ page }) => {
  await openApp(page, '/tasks');
  await addPhotos(page, [
    { name: 'a.png', buffer: await png(page, 800, 600, '#3b6') },
    { name: 'b.png', buffer: await png(page, 600, 800, '#36b') },
  ]);
  const tiles = page.locator(`${BOARD} button`);
  await expect(tiles).toHaveCount(2);
  const secondSrc = await tiles.nth(1).locator('img').last().getAttribute('src');

  // Передумал — фото на месте.
  await tiles.nth(0).click();
  await page.getByRole('button', { name: 'Удалить фото' }).click();
  await expect(page.getByTestId('photo-viewer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Не сейчас' }).click();
  await expect(tiles).toHaveCount(2);

  await tiles.nth(0).click();
  await page.getByRole('button', { name: 'Удалить фото' }).click();
  await page.getByRole('button', { name: 'Убрать с панели' }).click();
  await expect(tiles).toHaveCount(1);
  await expect(tiles.nth(0).locator('img').last()).toHaveAttribute('src', secondSrc!);

  // Убранный снимок не лежит в базе мёртвым грузом: куски помечены и пусты.
  const left = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const rows = await db.taskPhotos.where('taskId').equals('tasks-board').toArray();
    return rows.filter((r) => r.deletedAt).map((r) => r.data.length);
  });
  expect(left.length).toBeGreaterThan(0);
  expect(left.every((n) => n === 0)).toBe(true);
});
