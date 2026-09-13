import { test, expect, openApp } from './fixtures';
import type { Page } from '@playwright/test';

// Задача 15: хвост разбора «Задач» от 08.09, подтверждённый 12.09 —
// доступность строк, прокрутка к новой задаче, «Без проекта» как цель.

async function seed(page: Page, perProject: number) {
  await page.evaluate(async (n) => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null },
      { ...base('p2'), name: 'Здоровье', color: '#3aa35e', emoji: '🏃', sortOrder: 2000, archivedAt: null },
    ]);
    const task = (id: string, title: string, projectId: string, sortOrder: number) => ({
      ...base(id), title, notes: '', projectId, goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder,
    });
    const rows = [];
    for (let i = 0; i < n; i++) rows.push(task(`t1_${i}`, `Дело ${i}`, 'p1', (i + 1) * 1000));
    for (let i = 0; i < n; i++) rows.push(task(`t2_${i}`, `Здоровье ${i}`, 'p2', (i + 1) * 1000));
    await db.tasks.bulkPut(rows);
  }, perProject);
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Задачи' })).toBeVisible();
}

test('строка задачи открывается с клавиатуры, заголовки папок озвучивают состояние', async ({ page }) => {
  await openApp(page, '/tasks', { seenHints: ['tasks-quick-add', 'tasks-gestures'] });
  await seed(page, 2);
  const row = page.locator('[data-task-id="t1_0"]');
  await expect(row).toHaveAttribute('role', 'button');
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Задача' })).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть' }).click();

  const header = page.getByRole('button', { name: /Бизнес/ }).first();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'false');
});

test('задача из быстрого ввода докручивается на экран', async ({ page }) => {
  await openApp(page, '/tasks', { seenHints: ['tasks-quick-add', 'tasks-gestures'] });
  await seed(page, 25);
  const input = page.locator('input[placeholder="Что нужно сделать?"]');
  await input.fill('Купить молоко');
  await input.press('Enter');
  const created = page.getByText('Купить молоко', { exact: true });
  await expect(created).toBeVisible();
  const box = (await created.boundingBox())!;
  const vh = page.viewportSize()!.height;
  expect(box.y + box.height, 'новая задача должна быть в пределах экрана').toBeLessThanOrEqual(vh);
});

test('подсказка жестов говорит, как вложить папку в другую', async ({ page }) => {
  await openApp(page, '/tasks', { seenHints: ['tasks-quick-add'] });
  await seed(page, 1);
  await expect(page.getByText('Жесты списка')).toBeVisible();
  await expect(page.getByText(/вправо — вложить/)).toBeVisible();
});

test('на чистом приложении есть «Новый проект», а форма задачи видит папки третьего уровня', async ({ page }) => {
  await openApp(page, '/tasks', { seenHints: ['tasks-quick-add', 'tasks-gestures'] });
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    await db.projects.clear();
    await db.tasks.clear();
  });
  await page.reload();
  await expect(page.getByText('Пока нет задач')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Новый проект' })).toBeVisible();

  // Три уровня: Бизнес → Поставщики → Китай; задача в «Китае».
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.bulkPut([
      { ...base('a'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null, parentId: null },
      { ...base('b'), name: 'Поставщики', color: '#5b7cfa', emoji: '📦', sortOrder: 1000, archivedAt: null, parentId: 'a' },
      { ...base('c'), name: 'Китай', color: '#5b7cfa', emoji: '🇨🇳', sortOrder: 1000, archivedAt: null, parentId: 'b' },
    ]);
    await db.tasks.put({
      ...base('t'), title: 'Запросить КП', notes: '', projectId: 'c', goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null, completedAt: null,
      checklist: [], recurrence: null, tags: [], sortOrder: 1000,
    });
  });
  await page.reload();
  await page.getByText('Запросить КП', { exact: true }).click();
  const select = page.locator('select').filter({ has: page.locator('option', { hasText: 'Китай' }) });
  await expect(select).toHaveValue('c');
});

test('у задачи без времени с напоминанием — колокольчик в строке', async ({ page }) => {
  await openApp(page, '/tasks', { seenHints: ['tasks-quick-add', 'tasks-gestures'] });
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    await db.tasks.put({
      id: 'r', createdAt: now, updatedAt: now, deletedAt: null, title: 'Сдать отчёт', notes: '', projectId: null,
      goalId: null, priority: 0, dueDate: '2030-01-10', dueTime: null, duration: null, remindBefore: 1440,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: 1000,
    });
  });
  await page.reload();
  await expect(page.locator('[data-task-id="r"]').getByLabel('Напоминание включено')).toBeVisible();
});

test('заполненная форма задачи не закрывается свайпом молча', async ({ page }) => {
  await openApp(page, '/tasks', { seenHints: ['tasks-quick-add', 'tasks-gestures'] });
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await page.locator('textarea').first().fill('Важное дело');
  let asked = false;
  page.once('dialog', (d) => {
    asked = true;
    void d.dismiss();
  });
  await page.getByRole('button', { name: 'Закрыть' }).click();
  expect(asked).toBe(true);
  await expect(page.getByRole('heading', { name: 'Новая задача' })).toBeVisible();
});
