import { test, expect, openApp } from './fixtures';
import type { Page } from '@playwright/test';

// Свёрнутый проект прячет только свои задачи, подпроекты остаются на экране.
//
// Владелец, 22.10.2026: «если я сворачиваю проект — сворачиваются и
// подпроекты». Флаги свёрнутости и тогда были у каждого проекта свои, но
// подпроекты рисовались внутри содержимого родителя и уходили вместе с ним:
// чтобы увидеть задачи подпроекта, приходилось держать раскрытым весь
// родительский список.

async function seed(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null },
      { ...base('s1'), name: 'Поставщики', color: '#e0803a', emoji: '📦', sortOrder: 1100, archivedAt: null, parentId: 'p1' },
      { ...base('ss1'), name: 'Китай', color: '#d94f70', emoji: '🚢', sortOrder: 1110, archivedAt: null, parentId: 's1' },
    ] as never[]);
    const task = (id: string, title: string, projectId: string) => ({
      ...base(id), title, notes: '', projectId, goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: 1000,
    });
    await db.tasks.bulkPut([
      task('t1', 'Посчитать маржу', 'p1'),
      task('t2', 'Сверить прайс', 's1'),
      task('t3', 'Узнать срок доставки', 'ss1'),
    ] as never[]);
  });
  await page.goto('/tasks');
  await expect(page.locator('[data-task-id="t3"]')).toBeVisible();
}

/** Заголовок секции: кнопка с её именем внутри data-хука секции. Имя — без
 *  учёта регистра: у подпроекта оно набрано капителью через CSS. */
const header = (page: Page, id: string, name: string) =>
  page
    .locator(`[data-drop-key="${id}"]`)
    .getByRole('button', { name: new RegExp(name, 'i') })
    .first();

test('свернул проект — его задачи скрыты, подпроекты открыты и сворачиваются сами', async ({ page }) => {
  await openApp(page, '/tasks', { seenHints: ['tasks-quick-add', 'tasks-gestures'] });
  await seed(page);
  const p1 = header(page, 'p1', 'Бизнес');
  const s1 = header(page, 's1', 'Поставщики');

  await p1.click();
  await expect(p1).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-task-id="t1"]')).toHaveCount(0);
  await expect(page.locator('[data-task-id="t2"]')).toBeVisible();
  await expect(page.locator('[data-task-id="t3"]')).toBeVisible();
  await expect(s1).toHaveAttribute('aria-expanded', 'true');

  // Подпроект при свёрнутом родителе сворачивается сам — и тоже не уносит
  // за собой своего потомка третьего уровня.
  await s1.click();
  await expect(page.locator('[data-task-id="t2"]')).toHaveCount(0);
  await expect(page.locator('[data-task-id="t3"]')).toBeVisible();

  // Родителя развернули — у подпроекта осталось его собственное состояние.
  await p1.click();
  await expect(page.locator('[data-task-id="t1"]')).toBeVisible();
  await expect(s1).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-task-id="t2"]')).toHaveCount(0);
});

test('задача, отпущенная в зазоре между подпроектами свёрнутого проекта, — в ближайший подпроект', async ({ page }) => {
  // Подпроекты лежат в прямоугольнике свёрнутого родителя, а зазоры между
  // ними — ни в чьём собственном. Самым маленьким прямоугольником под
  // пальцем там оказывался родитель: задача уходила в его скрытый список и
  // пропадала с экрана.
  await openApp(page, '/tasks', {
    seenHints: ['tasks-quick-add', 'tasks-gestures'],
    collapsedProjects: ['p1'],
  });
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null },
      { ...base('s1'), name: 'Поставщики', color: '#e0803a', emoji: '📦', sortOrder: 1100, archivedAt: null, parentId: 'p1' },
      { ...base('s2'), name: 'Реклама', color: '#3aa35e', emoji: '📣', sortOrder: 1200, archivedAt: null, parentId: 'p1' },
    ] as never[]);
    const task = (id: string, title: string, projectId: string) => ({
      ...base(id), title, notes: '', projectId, goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: 1000,
    });
    await db.tasks.bulkPut([
      task('t1', 'Посчитать маржу', 'p1'),
      task('t2', 'Сверить прайс', 's1'),
      task('t3', 'Запустить объявление', 's2'),
    ] as never[]);
  });
  await page.goto('/tasks');
  await expect(page.locator('[data-task-id="t3"]')).toBeVisible();
  await expect(page.locator('[data-task-id="t1"]')).toHaveCount(0);

  // Задачу из «Рекламы» ведут вверх и отпускают в зазоре сразу под
  // «Поставщиками». Подход снизу — устойчивый случай: у «Поставщиков» линии
  // вставки ещё нет, их край не двигается, и палец остаётся в зазоре. Сверху
  // так не проверить: уходящая линия вставки сама сдвигает вёрстку под пальцем.
  await page.getByText('Запустить объявление', { exact: true }).hover();
  await page.mouse.down();
  await expect(page.locator('.fixed.z-\\[70\\]'), 'перенос не стартовал — плашки нет').toBeVisible({ timeout: 2000 });

  // Геометрия — уже во время жеста: линия вставки меняет высоту секций.
  const s1Box = (await page.locator('[data-drop-key="s1"]').boundingBox())!;
  const s2Box = (await page.locator('[data-drop-key="s2"]').boundingBox())!;
  const gapTop = s1Box.y + s1Box.height;
  expect(s2Box.y - gapTop, 'зазор между подпроектами').toBeGreaterThan(6);
  await page.mouse.move(s1Box.x + s1Box.width / 2, gapTop + 3, { steps: 8 });
  await expect(page.locator('[data-drop-key="s1"]')).toHaveClass(/(^|\s)ring-lh-accent(\s|$)/);
  await expect(page.locator('[data-drop-key="p1"]')).not.toHaveClass(/(^|\s)ring-lh-accent(\s|$)/);
  await page.mouse.up();

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts');
        return (await db.tasks.get('t3'))?.projectId ?? null;
      }),
    )
    .toBe('s1');
  await expect(page.locator('[data-task-id="t3"]')).toBeVisible();
});
