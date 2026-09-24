import { test, expect, openApp } from './fixtures';

// Корзина: восстановленная задача видна там, куда её вернули.
//
// Прогон 13–17.09: задачу удалили, потом удалили её проект, потом вернули
// задачу из корзины — и её не было ни в одной секции «Задач». Удаление
// проекта отвязывает только живые задачи («Его задачи останутся без
// проекта»), а лежавшая в корзине хранила ссылку на удалённый проект; секции
// же строятся только по живым проектам. Без срока такую задачу не видно ни на
// «Сегодня», ни в календаре — она пропадала из приложения совсем.
//
// Сид — ровно то, что оставляет удаление проекта: задача в корзине со ссылкой
// на проект, который тоже в корзине. Корзина бессрочная, так что такие пары
// лежат и у тех, кто удалял проекты до этой починки.

test('задача из корзины после удаления её проекта возвращается в «Без проекта»', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: ts, updatedAt: ts });
    await db.projects.put({
      ...base('p1'), name: 'Ремонт', color: '#5b7cfa', emoji: '📁', sortOrder: 1000,
      archivedAt: null, deletedAt: ts,
    } as never);
    await db.tasks.put({
      ...base('t1'), title: 'Купить плитку', notes: '', projectId: 'p1', goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null, completedAt: null,
      checklist: [], recurrence: null, tags: [], sortOrder: 1000, deletedAt: ts,
    } as never);
  });

  await page.goto('/more/trash');
  // В корзине две строки — задача и её проект; возвращаем только задачу.
  await page
    .locator('.card > div', { hasText: 'Купить плитку' })
    .getByRole('button', { name: 'Восстановить', exact: true })
    .click();
  await expect(page.getByText('Восстановлено', { exact: true })).toBeVisible();

  await page.goto('/tasks');
  await expect(
    page.locator('[data-drop-key="__none__"]').getByText('Купить плитку', { exact: true }),
  ).toBeVisible();

  // Проект остался в корзине: его удаляли отдельным решением.
  await page.goto('/more/trash');
  await expect(page.getByText('Ремонт', { exact: true })).toBeVisible();
  await expect(page.getByText('Купить плитку', { exact: true })).toHaveCount(0);
});
