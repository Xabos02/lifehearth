import { test, expect, openApp } from './fixtures';

// Файлы любого формата у задачи.
//
// Владелец: «добавить возможность в задачи добавлять не только картинки, но и
// файлы любых форматов и по максимуму объём». Механика та же, что у заметок и
// чата: файл режется на куски по 400 КБ и уезжает синком по частям; предел 8 МБ.

test('файл прикрепляется к задаче, сохраняется чанками и показывается карточкой', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toBeVisible();
  await page.locator('textarea[placeholder="Что нужно сделать?"]').fill('Смета на ремонт');

  await page.locator('input[type="file"]:not([accept])').setInputFiles({
    name: 'смета.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 тестовое содержимое сметы'),
  });
  await expect(page.getByTestId('task-pending-files')).toContainText('смета.pdf');
  await expect(page.getByTestId('task-pending-files')).toContainText('добавится при сохранении');

  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toHaveCount(0);

  const stored = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const task = (await db.tasks.toArray()).find((t: { title: string }) => t.title === 'Смета на ремонт')!;
    const rows = await db.taskFiles.where('taskId').equals(task.id).toArray();
    return { count: rows.length, name: rows[0]?.name, mime: rows[0]?.mime, total: rows[0]?.total };
  });
  expect(stored.count).toBeGreaterThan(0);
  expect(stored).toMatchObject({ name: 'смета.pdf', mime: 'application/pdf' });
  expect(stored.count).toBe(stored.total);

  // Открыли задачу снова — файл на месте карточкой, с размером.
  await page.getByText('Смета на ремонт').click();
  await expect(page.getByTestId('note-attachments')).toContainText('смета.pdf');
});

test('файл тяжелее предела не принимается, а объясняется', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toBeVisible();

  await page.locator('input[type="file"]:not([accept])').setInputFiles({
    name: 'огромный.zip',
    mimeType: 'application/zip',
    buffer: Buffer.alloc(9 * 1024 * 1024, 1),
  });
  await expect(page.getByText(/Файл больше/)).toBeVisible();
  await expect(page.getByTestId('task-pending-files')).toHaveCount(0);
});
