import type { Page } from '@playwright/test';
import { test, expect, openApp } from './fixtures';

// Задача удалённого проекта: где она оказывается после возврата.
//
// Прогон 13–17.09: задачу удалили, потом удалили её проект, потом вернули
// задачу из корзины — и её не было ни в одной секции «Задач». Удаление
// проекта отвязывает только живые задачи («Его задачи останутся без
// проекта»), а лежавшая в корзине хранила ссылку на удалённый проект; секции
// же строятся только по живым проектам. Без срока такую задачу не видно ни на
// «Сегодня», ни в календаре — она пропадала из приложения совсем.
//
// Корень — в раскладке по секциям, и первый тест бьёт в него: живая задача со
// ссылкой на удалённый или стёртый насовсем проект лежит в «Без проекта».
// Так покрыты и задачи, возвращённые из корзины до починки, и правка задачи с
// другого устройства, пришедшая после удаления проекта. Второй тест — про
// саму корзину: возвращая задачу, она снимает мёртвую ссылку и в базе (на
// другие устройства задача уезжает уже без проекта), а ссылку на живой проект
// не трогает. В обоих — контрольные образцы: задача живого проекта остаётся в
// нём, задача архивного прячется вместе с проектом, как и прежде.

/** Проекты и задачи — прямо в базу. deletedAt у задач — чтобы положить их
 *  в корзину. */
async function seed(page: Page, tasksDeleted: boolean) {
  await page.evaluate(async (tasksDeleted) => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: ts, updatedAt: ts, deletedAt: null as string | null });
    const project = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
      ...base(id), name, color: '#5b7cfa', emoji: '📁', sortOrder: 1000, archivedAt: null, ...extra,
    });
    const task = (id: string, title: string, projectId: string) => ({
      ...base(id), title, notes: '', projectId, goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null, completedAt: null,
      checklist: [], recurrence: null, tags: [], sortOrder: 1000,
      deletedAt: tasksDeleted ? ts : null,
    });
    await db.projects.bulkPut([
      project('p-live', 'Кухня'),
      project('p-del', 'Ремонт', { deletedAt: ts }),
      project('p-arch', 'Дача', { archivedAt: ts }),
    ] as never[]);
    await db.tasks.bulkPut([
      task('t1', 'Купить плитку', 'p-del'),
      // Проекта p-gone в базе нет: его стёрли из корзины насовсем.
      task('t2', 'Позвонить плиточнику', 'p-gone'),
      task('t3', 'Помыть посуду', 'p-live'),
      task('t4', 'Покрасить забор', 'p-arch'),
    ] as never[]);
  }, tasksDeleted);
}

test('живая задача удалённого или стёртого проекта — в «Без проекта»', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page, false);

  const none = page.locator('[data-drop-key="__none__"]');
  await expect(none.getByText('Купить плитку', { exact: true })).toBeVisible();
  await expect(none.getByText('Позвонить плиточнику', { exact: true })).toBeVisible();
  // Контроль: задача живого проекта — в его секции; задача архивного проекта
  // скрыта вместе с ним — архив ставит на паузу, а не отвязывает.
  await expect(
    page.locator('[data-drop-key="p-live"]').getByText('Помыть посуду', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Покрасить забор', { exact: true })).toHaveCount(0);

  // Шит заморозки раскладывает по тому же правилу: задача, видная в «Без
  // проекта», предлагается и там — её название на экране второй раз.
  await page.getByRole('button', { name: 'Заморозить задачи', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Заморозить задачи', exact: true })).toBeVisible();
  await expect(page.getByText('Купить плитку', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Позвонить плиточнику', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Помыть посуду', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Покрасить забор', { exact: true })).toHaveCount(0);
});

test('корзина, возвращая задачу, снимает ссылку на удалённый проект и не трогает живой', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page, true);

  await page.goto('/more/trash');
  for (const id of ['t1', 't2', 't3']) {
    const row = page.getByTestId(`trash-${id}`);
    await row.getByRole('button', { name: 'Восстановить', exact: true }).click();
    // Следующую — когда строка ушла: пока запись идёт, повторное нажатие
    // корзина глотает (защита от двойного тапа).
    await expect(row).toHaveCount(0);
  }
  const projectIds = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.tasks.bulkGet(['t1', 't2', 't3'])).map((task) => task?.projectId ?? null);
  });
  expect(projectIds).toEqual([null, null, 'p-live']);
  // Проект остался в корзине: его удаляли отдельным решением.
  await expect(page.getByTestId('trash-p-del')).toBeVisible();

  await page.goto('/tasks');
  await expect(
    page.locator('[data-drop-key="p-live"]').getByText('Помыть посуду', { exact: true }),
  ).toBeVisible();
});
