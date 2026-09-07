import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Тап по снимку в строке задачи открывает снимок, а не форму задачи.
//
// Снимок был просто картинкой без обработчика: нажатие всплывало в строку и
// открывало редактирование. Рассмотреть фото было нельзя вовсе — хотя
// прикрепляют его к задаче именно за этим: «замерил, сфотографировал, потом
// посмотрю».

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function seed(page: Page, photos: string[]) {
  await page.evaluate(async (photos) => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Быт', color: '#5b7cfa', emoji: '🏠', sortOrder: 1000, archivedAt: null },
    ]);
    await db.tasks.put({
      ...base('t1'), title: 'Замерить крышку унитаза', notes: '', projectId: 'p1', goalId: null,
      priority: 0, dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: 1000, photos,
    } as never);
  }, photos);
  await page.goto('/tasks');
  await expect(page.getByText('Замерить крышку унитаза')).toBeVisible();
}

test('тап по снимку открывает снимок, а не задачу', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page, [PNG]);

  await page.getByRole('button', { name: 'Открыть фото' }).first().click();

  await expect(page.getByTestId('photo-viewer')).toBeVisible();
  // Форма задачи не открылась: её поля на экране отсутствуют.
  await expect(page.getByLabel('Название')).toHaveCount(0);
});

test('снимок закрывается тапом по фону', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page, [PNG]);

  await page.getByRole('button', { name: 'Открыть фото' }).first().click();
  await expect(page.getByTestId('photo-viewer')).toBeVisible();

  // Тап в угол — мимо самого снимка.
  await page.getByTestId('photo-viewer').click({ position: { x: 6, y: 6 } });
  await expect(page.getByTestId('photo-viewer')).toHaveCount(0);
});

test('при нескольких снимках виден счётчик и работают стрелки', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page, [PNG, PNG, PNG]);

  // Открываем второй — просмотрщик обязан открыться именно на нём, а не с начала.
  await page.getByRole('button', { name: 'Открыть фото' }).nth(1).click();
  await expect(page.getByTestId('photo-viewer')).toContainText('2 / 3');

  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('photo-viewer')).toContainText('3 / 3');
  // За последним снимка нет — счётчик не должен уехать за границу.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('photo-viewer')).toContainText('3 / 3');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('photo-viewer')).toHaveCount(0);
});

test('один снимок — без счётчика', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page, [PNG]);

  await page.getByRole('button', { name: 'Открыть фото' }).first().click();
  await expect(page.getByTestId('photo-viewer')).not.toContainText('/');
});
