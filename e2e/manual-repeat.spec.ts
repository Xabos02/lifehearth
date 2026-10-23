import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Ручной повтор (задача 39): у владельца гибкий график, и когда задаче пора
// повториться, знает только он. Отмеченная задача не уезжает в «Выполненные» и
// не получает дату по расписанию — она спит на своём месте, пока её не
// запустят кнопкой ↻ у строки или «Запустить все» у проекта.

async function seed(page: Page, sleeping: string[] = []) {
  await page.evaluate(async (sleeping) => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    const task = (id: string, title: string, sortOrder: number, extra = {}) => ({
      ...base(id), title, notes: '', projectId: 'p1', goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: sleeping.includes(id) ? now : null, checklist: [], recurrence: null, tags: [],
      sortOrder, ...extra,
    });
    const manual = { recurrence: { type: 'manual' } };
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Дом', color: '#4ade80', emoji: '📁', sortOrder: 1000, archivedAt: null },
    ] as never[]);
    await db.tasks.bulkPut([
      task('t1', 'Генеральная уборка', 1000, manual),
      task('t2', 'Заменить фильтр', 2000),
      task('t3', 'Полить цветы', 3000, manual),
    ] as never[]);
  }, sleeping);
  await page.goto('/tasks');
  await expect(page.getByText('Заменить фильтр')).toBeVisible();
}

const section = (page: Page) => page.locator('section[data-drop-key="p1"]');
const titles = (page: Page) =>
  section(page).evaluate((s) =>
    // Первая карточка секции — живой список; «Выполненные» раскрываются ниже.
    [...(s.querySelector('.card')?.querySelectorAll('[data-task-id]') ?? [])].map((e) => e.getAttribute('aria-label')),
  );

test('отметил ручную задачу — она осталась на месте, ↻ возвращает её в работу', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);
  const row = section(page).locator('[data-task-id="t1"]');

  await row.getByRole('button', { name: 'Выполнить' }).click();
  await expect(page.getByText('Сделано · запустите снова, когда пора')).toBeVisible();
  // На своём месте, отмеченная, с днём отметки; в «Выполненные» не ушла.
  await expect(row.getByRole('button', { name: 'Снять отметку' })).toBeVisible();
  await expect(row).toContainText('сделано сегодня');
  await expect.poll(() => titles(page)).toEqual(['Генеральная уборка', 'Заменить фильтр', 'Полить цветы']);
  await expect(section(page).getByText('Выполненные')).toHaveCount(0);
  // Счётчик проекта — что осталось сделать: спящая уже сделана.
  await expect(section(page).locator('.project-count')).toHaveText('2');

  await row.getByRole('button', { name: 'Запустить снова' }).click();
  await expect(page.getByText('Задача запущена')).toBeVisible();
  // На том же месте снова не отмеченная задача, а прошлый раз — в истории.
  await expect.poll(() => titles(page)).toEqual(['Генеральная уборка', 'Заменить фильтр', 'Полить цветы']);
  const fresh = section(page).locator('.card').first().locator('[data-task-id]').first();
  await expect(fresh.getByRole('button', { name: 'Выполнить' })).toBeVisible();
  await expect(section(page).getByRole('button', { name: 'Запустить снова' })).toHaveCount(0);
  await expect(section(page).getByText('Выполненные')).toBeVisible();
  await expect(section(page).locator('.project-count')).toHaveText('3');
});

test('«Запустить все» у проекта поднимает все спящие разом', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page, ['t1', 't3']);
  await expect(section(page).getByRole('button', { name: 'Запустить снова' })).toHaveCount(2);

  await section(page).getByRole('button', { name: 'Запустить все' }).click();
  await expect(page.getByText('Запущено: 2')).toBeVisible();
  await expect(section(page).getByRole('button', { name: 'Запустить снова' })).toHaveCount(0);
  // Кнопка у заголовка есть, только когда есть что запускать.
  await expect(section(page).getByRole('button', { name: 'Запустить все' })).toHaveCount(0);
  await expect(section(page).locator('.project-count')).toHaveText('3');
});

test('спящую перевели в редакторе на расписание — серия не обрывается', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page, ['t1']);
  await section(page).getByText('Генеральная уборка').click();
  await page.getByRole('button', { name: 'День', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  // Отмеченная ушла в историю, на её месте — следующий круг на завтра.
  await expect(section(page).getByText('Выполненные')).toBeVisible();
  const fresh = section(page).locator('.card').first().locator('[data-task-id]').first();
  await expect(fresh).toHaveAttribute('aria-label', 'Генеральная уборка');
  await expect(fresh.getByRole('button', { name: 'Выполнить' })).toBeVisible();
  await expect(fresh).toContainText('Завтра');
});

test('в редакторе «Вручную» убирает интервал и объясняет, что будет', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);
  await page.getByText('Заменить фильтр').click();
  await page.getByRole('button', { name: 'Неделя', exact: true }).click();
  await expect(page.getByText('Интервал (недель)')).toBeVisible();

  await page.getByRole('button', { name: 'Вручную', exact: true }).click();
  await expect(page.getByText('Интервал (недель)')).toHaveCount(0);
  await expect(page.getByText(/Отмеченная задача останется на месте в списке/)).toBeVisible();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(section(page).locator('[data-task-id="t2"]')).toContainText('Вручную');
});
