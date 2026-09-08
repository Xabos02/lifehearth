import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Разовые поручения собираются отдельно внутри своего же проекта.
//
// В один проект складывают и постоянное («вести учёт»), и разовое («снять
// деньги», «замерить крышку»). Вперемешку список перестаёт читаться:
// постоянное тонет в мелочи, а мелочь выглядит так же весомо.
//
// Пометка ставится РУКАМИ, а не угадывается по сроку: дедлайн у постоянной
// задачи бывает не реже, чем у разовой, и догадка врала бы ровно на них.
// Группировка выключается в настройках — тому, кто так о задачах не думает,
// она только мешает.

async function seed(page: Page, opts: { temporary?: boolean } = {}) {
  await page.evaluate(async (opts) => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    const task = (id: string, title: string, sortOrder: number, extra = {}) => ({
      ...base(id), title, notes: '', projectId: 'p1', goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder, ...extra,
    });
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Приоритетные', color: '#5b7cfa', emoji: '📁', sortOrder: 1000, archivedAt: null },
    ] as never[]);
    await db.tasks.bulkPut([
      // Временная стоит ПЕРВОЙ по sortOrder — значит перестановка её вниз это
      // работа группировки, а не случайное совпадение порядка.
      task('t1', 'Снять деньги', 1000, opts.temporary ? { temporary: true } : {}),
      task('t2', 'Вести учёт расходов', 2000),
      task('t3', 'Проверять остатки', 3000),
    ] as never[]);
  }, opts);
  await page.goto('/tasks');
  await expect(page.getByText('Вести учёт расходов')).toBeVisible();
}

/** Названия задач в порядке, в котором они стоят на экране. */
async function shown(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-task-id] p')]
      .map((e) => e.textContent?.trim() ?? '')
      .filter(Boolean),
  );
}

test('без помеченных задач группы нет — подпись не появляется', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);

  await expect.poll(() => shown(page)).toEqual([
    'Снять деньги',
    'Вести учёт расходов',
    'Проверять остатки',
  ]);
  await expect(page.getByText('Временные', { exact: true })).toHaveCount(0);
});

test('помеченная задача уходит вниз под подпись «Временные»', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page, { temporary: true });

  await expect(page.getByText('Временные', { exact: true })).toBeVisible();
  // Порядок постоянных между собой сохранён, временная — в конце.
  await expect.poll(() => shown(page)).toEqual([
    'Вести учёт расходов',
    'Проверять остатки',
    'Снять деньги',
  ]);
});

test('выключатель в настройках возвращает единый список', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page, { temporary: true });
  await expect(page.getByText('Временные', { exact: true })).toBeVisible();

  await page.goto('/more/settings');
  await page.getByRole('switch', { name: 'Временные задачи отдельно' }).click();
  // Ждём саму запись, а не скорость: настройка уезжает в IndexedDB, и переход
  // на «Задачи» успевал случиться раньше — тест падал через раз в общем
  // прогоне и проходил в одиночку.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts');
        return (await db.settings.get('app'))?.groupTemporary ?? null;
      }),
    )
    .toBe(false);
  await page.goto('/tasks');

  // Ждём ИТОГОВЫЙ список, а не первый кадр после перехода. Проверка «подписи
  // нет» сама по себе проходит и на пустом DOM посреди навигации — порядок её
  // страхует: пустой список ей не подойдёт.
  await expect.poll(() => shown(page)).toEqual([
    'Снять деньги',
    'Вести учёт расходов',
    'Проверять остатки',
  ]);
  await expect(page.getByText('Временные', { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      return (await db.tasks.get('t1'))?.temporary ?? null;
    }),
  ).toBe(true);
});

test('пометка ставится из формы задачи и сразу перестраивает список', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);

  await page.getByText('Снять деньги', { exact: true }).first().click();
  await page.getByRole('switch', { name: 'Временная' }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();

  await expect(page.getByText('Временные', { exact: true })).toBeVisible();
  await expect.poll(() => shown(page)).toEqual([
    'Вести учёт расходов',
    'Проверять остатки',
    'Снять деньги',
  ]);
});
