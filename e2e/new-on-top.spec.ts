import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Новый проект и новая задача встают первыми в своём списке, а не в конец.
//
// Владелец, 16.11.2026: «Когда я добавляю новый проект, он должен отображаться
// в самом вверху, а не в самом низу, задачи также». Список дописывался снизу,
// и только что заведённое приходилось искать прокруткой.

async function seed(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    const task = (id: string, title: string, sortOrder: number) => ({
      ...base(id), title, notes: '', projectId: 'p1', goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder,
    });
    await db.projects.clear();
    await db.tasks.clear();
    // Порядки как в живой базе: от переноса ((i+1)*1000) и от прежнего
    // создания (Date.now()) — новое должно встать выше обоих.
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Дом', color: '#5b7cfa', emoji: '📁', parentId: null, sortOrder: 1000, archivedAt: null },
      { ...base('p2'), name: 'Работа', color: '#ef4444', emoji: '📁', parentId: null, sortOrder: Date.now() - 60_000, archivedAt: null },
    ] as never[]);
    await db.tasks.bulkPut([
      task('t1', 'Снять деньги', 1000),
      task('t2', 'Вынести мусор', Date.now() - 60_000),
    ] as never[]);
  });
  await page.goto('/tasks');
  await expect(page.getByText('Вынести мусор')).toBeVisible();
}

/** Названия задач в порядке, в котором они стоят на экране. */
async function tasksShown(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-task-id]')]
      .map((e) => e.querySelector('p')?.textContent?.trim() ?? '')
      .filter(Boolean),
  );
}

/** Проекты из списка names в порядке заголовков на экране. */
async function projectsShown(page: Page, names: string[]): Promise<string[]> {
  const headings = await page.getByRole('heading').allTextContents();
  return headings.flatMap((h) => names.filter((n) => h.includes(n)));
}

test('новый проект встаёт первым в списке', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);

  await page.getByRole('button', { name: 'Новый проект' }).click();
  await page.getByPlaceholder('Например, «Ремонт»').fill('Ремонт кухни');
  await page.getByRole('button', { name: 'Сохранить' }).click();

  const names = ['Ремонт кухни', 'Дом', 'Работа'];
  await expect.poll(() => projectsShown(page, names)).toEqual(names);
});

test('новая задача из карточки встаёт первой в проекте', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);

  // «Дом» — первый проект на экране.
  await page.getByRole('button', { name: 'Добавить задачу в проект' }).first().click();
  await page.locator('textarea[placeholder="Что нужно сделать?"]').fill('Позвонить мастеру');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);

  await expect.poll(() => tasksShown(page)).toEqual(['Позвонить мастеру', 'Снять деньги', 'Вынести мусор']);
});

// Новое встаёт наверх, а заводят его и снизу — строкой «+ Задача» под
// длинным проектом, кнопкой «Новый проект» под всем списком. Без докрутки оно
// оказывалось за краем экрана: шторка закрылась, а нового не видно.

async function seedLong(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.clear();
    await db.tasks.clear();
    const names = ['Дом', 'Работа', 'Учёба', 'Спорт', 'Финансы', 'Поездки'];
    await db.projects.bulkPut(
      names.map((name, i) => ({
        ...base(`p${i + 1}`), name, color: '#5b7cfa', emoji: '📁', parentId: null, sortOrder: (i + 1) * 1000, archivedAt: null,
      })) as never[],
    );
    await db.tasks.bulkPut(
      names.flatMap((_, pi) =>
        Array.from({ length: pi === 0 ? 15 : 3 }, (_, i) => ({
          ...base(`t${pi}-${i}`), title: `Дело ${pi + 1}.${i + 1}`, notes: '', projectId: `p${pi + 1}`, goalId: null,
          priority: 0, dueDate: null, dueTime: null, duration: null, remindBefore: null,
          completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: (i + 1) * 1000,
        })),
      ) as never[],
    );
  });
  await page.goto('/tasks');
  await expect(page.getByText('Дело 1.15', { exact: true })).toBeVisible();
}

/** Узел целиком на экране: ниже липкой шапки и выше края ленты. */
async function onScreen(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    const sc = document.getElementById('app-scroll');
    if (!el || !sc) return false;
    const r = el.getBoundingClientRect();
    const cr = sc.getBoundingClientRect();
    const top = Math.max(cr.top, sc.querySelector('header')?.getBoundingClientRect().bottom ?? cr.top);
    return r.top >= top - 1 && r.bottom <= cr.bottom + 1;
  }, selector);
}

test('нижняя «+ Задача» длинного проекта: экран доезжает до новой задачи наверху', async ({ page }) => {
  await openApp(page, '/tasks');
  await seedLong(page);

  // Строка «+ Задача» под 15 задачами «Дома». В секции, а не по всей странице:
  // стрелка строки быстрого ввода называется так же.
  const add = page.locator('section[data-drop-key="p1"]').getByRole('button', { name: 'Добавить задачу', exact: true });
  await add.scrollIntoViewIfNeeded();
  await add.click();
  await page.locator('textarea[placeholder="Что нужно сделать?"]').fill('Позвонить мастеру');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);

  const id = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.tasks.toArray()).find((x) => x.title === 'Позвонить мастеру')!.id;
  });
  await expect.poll(() => tasksShown(page).then((l) => l[0])).toBe('Позвонить мастеру');
  await expect.poll(() => onScreen(page, `[data-task-id="${id}"]`)).toBe(true);
});

test('«Новый проект» под списком: экран доезжает до нового проекта наверху', async ({ page }) => {
  await openApp(page, '/tasks');
  await seedLong(page);

  const add = page.getByRole('button', { name: 'Новый проект' });
  await add.scrollIntoViewIfNeeded();
  await add.click();
  await page.getByPlaceholder('Например, «Ремонт»').fill('Ремонт кухни');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);

  const id = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.projects.toArray()).find((x) => x.name === 'Ремонт кухни')!.id;
  });
  await expect.poll(() => onScreen(page, `[data-drop-key="${id}"]`)).toBe(true);
});

// Владелец, 16.11.2026, выбирая между двумя правилами: «важные над новыми».
// Новая обычная встаёт первой среди обычных — сразу под важными, что стоят
// во главе списка; новая важная — на самый верх.
test('важные во главе остаются над новой обычной задачей', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    const task = (id: string, title: string, priority: number, sortOrder: number) => ({
      ...base(id), title, notes: '', projectId: null, goalId: null, priority,
      dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder,
    });
    await db.projects.clear();
    await db.tasks.clear();
    await db.tasks.bulkPut([
      // Поднятая выбором «Высокого» и стоящая после переноса.
      task('t1', 'Оплатить свет', 3, -Date.now() + 60_000),
      task('t2', 'Продлить страховку', 3, 1000),
      task('t3', 'Снять деньги', 0, 2000),
    ] as never[]);
  });
  await page.goto('/tasks');
  await expect(page.getByText('Снять деньги')).toBeVisible();

  const input = page.getByPlaceholder('Что нужно сделать?');
  await input.fill('Купить лампочки');
  await input.press('Enter');
  await expect(page.getByText('Купить лампочки', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  await expect.poll(() => tasksShown(page)).toEqual(['Оплатить свет', 'Продлить страховку', 'Купить лампочки', 'Снять деньги']);

  // Следующая обычная — выше предыдущей новой, но всё ещё под важными.
  await input.fill('Вынести мусор');
  await input.press('Enter');
  await expect(page.getByText('Вынести мусор', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  await expect.poll(() => tasksShown(page)).toEqual([
    'Оплатить свет', 'Продлить страховку', 'Вынести мусор', 'Купить лампочки', 'Снять деньги',
  ]);

  // Новая важная — на самый верх.
  await input.fill('Отправить отчёт !!! ');
  await input.press('Enter');
  await expect.poll(() => tasksShown(page).then((l) => l[0])).toBe('Отправить отчёт');
});
