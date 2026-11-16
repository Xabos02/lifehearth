import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Высокий приоритет поднимает задачу на самый верх её списка.
//
// В «Задачах» порядок ручной — перетаскиванием, и важное тонуло там, где его
// когда-то завели. Поднимаем ОДИН раз, в момент выбора: дальше задачу можно
// утащить куда угодно, и следующее сохранение не вернёт её наверх. Закрепить
// высокие наверху навсегда значило бы отнять право поставить обычную задачу
// выше важной.

async function seed(page: Page, projectId: string | null, high: string[] = []) {
  await page.evaluate(
    async ({ projectId, high }) => {
      const { db } = await import('/src/db/db.ts');
      const now = new Date().toISOString();
      const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
      const task = (id: string, title: string, sortOrder: number) => ({
        ...base(id), title, notes: '', projectId, goalId: null, priority: high.includes(id) ? 3 : 0,
        dueDate: null, dueTime: null, duration: null, remindBefore: null,
        completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder,
      });
      await db.projects.clear();
      await db.tasks.clear();
      if (projectId)
        await db.projects.bulkPut([
          { ...base(projectId), name: 'Дом', color: '#5b7cfa', emoji: '📁', sortOrder: 1000, archivedAt: null },
        ] as never[]);
      await db.tasks.bulkPut([
        task('t1', 'Снять деньги', 1000),
        task('t2', 'Вести учёт расходов', 2000),
        task('t3', 'Проверять остатки', 3000),
      ] as never[]);
    },
    { projectId, high },
  );
  await page.goto('/tasks');
  await expect(page.getByText('Вести учёт расходов')).toBeVisible();
}

/** Названия задач в порядке, в котором они стоят на экране. */
async function shown(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-task-id]')]
      .map((e) => e.querySelector('p')?.textContent?.trim() ?? '')
      .filter(Boolean),
  );
}

async function setPriority(page: Page, title: string, label: string) {
  await page.getByText(title, { exact: true }).click();
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);
}

test('высокий приоритет в карточке ставит задачу первой в проекте', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page, 'p1');

  await setPriority(page, 'Проверять остатки', 'Высокий');
  await expect.poll(() => shown(page)).toEqual(['Проверять остатки', 'Снять деньги', 'Вести учёт расходов']);

  // Поднятая позже встаёт выше поднятой раньше.
  await setPriority(page, 'Вести учёт расходов', 'Высокий');
  await expect.poll(() => shown(page)).toEqual(['Вести учёт расходов', 'Проверять остатки', 'Снять деньги']);
});

test('уже высокая задача при сохранении остаётся на своём месте', async ({ page }) => {
  await openApp(page, '/tasks');
  // Высокая стоит посередине — так её поставил человек.
  await seed(page, 'p1', ['t2']);

  await page.getByText('Вести учёт расходов', { exact: true }).click();
  await page.getByPlaceholder('Детали…').fill('по чекам за месяц');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);
  await expect.poll(() => shown(page)).toEqual(['Снять деньги', 'Вести учёт расходов', 'Проверять остатки']);

  // Другой приоритет, кроме высокого, порядок не трогает — ни вверх, ни вниз.
  await setPriority(page, 'Снять деньги', 'Средний');
  await expect.poll(() => shown(page)).toEqual(['Снять деньги', 'Вести учёт расходов', 'Проверять остатки']);
});

// С 1.56.0 любая новая задача встаёт первой (new-on-top.spec.ts), так что
// «!!!» при добавлении место уже не решает: она задаёт высокий приоритет, а
// выше стоит добавленная позже. Важную добавляем первой — иначе тест прошёл
// бы и без разбора «!!!».
test('«!!!» в строке добавления — высокий приоритет, а выше встаёт добавленная следом', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page, null);

  const input = page.getByPlaceholder('Что нужно сделать?');
  await input.fill('Оплатить свет !!! ');
  await input.press('Enter');
  // Поле чистится, когда задача уже записана. Вписать следующую раньше —
  // и запоздалая очистка сотрёт её до Enter.
  await expect(page.getByText('Оплатить свет', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  await input.fill('Обычная');
  await input.press('Enter');
  await expect.poll(() => shown(page)).toEqual([
    'Обычная',
    'Оплатить свет',
    'Снять деньги',
    'Вести учёт расходов',
    'Проверять остатки',
  ]);
  const priority = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.tasks.toArray()).find((x) => x.title === 'Оплатить свет')?.priority;
  });
  expect(priority).toBe(3);
});
