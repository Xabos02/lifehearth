import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Подпроект переставляется внутри своего родителя.
//
// Этой ветки не было вовсе. Ветвление в finish разбирало два случая — смену
// уровня и переупорядочивание НА ВЕРХНЕМ уровне, — а подпроект, остающийся
// внутри папки, проваливался мимо обеих: жест шёл, плашка ехала за пальцем,
// между папками верхнего уровня рисовалась линия «встанет сюда», а при
// отпускании не происходило ничего. Два взаимоисключающих обещания и
// молчаливый отказ: человек решает, что перетаскивание сломано.
//
// Порядка у подпроектов при этом не существовало в принципе: он задавался
// моментом создания и после этого не менялся ничем в интерфейсе.

async function seed(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null, parentId: null },
      { ...base('s1'), name: 'Поставщики', color: '#f59e0b', emoji: '📦', sortOrder: 1000, archivedAt: null, parentId: 'p1' },
      { ...base('s2'), name: 'Реклама', color: '#10b981', emoji: '📣', sortOrder: 2000, archivedAt: null, parentId: 'p1' },
      { ...base('s3'), name: 'Отчёты', color: '#a855f7', emoji: '📊', sortOrder: 3000, archivedAt: null, parentId: 'p1' },
    ] as never[]);
  });
  await page.goto('/tasks');
  await expect(page.getByText('Отчёты', { exact: true })).toBeVisible();
}

/** Порядок подпроектов «Бизнеса» в базе. */
async function order(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const all = await db.projects.toArray();
    return all
      .filter((p) => p.parentId === 'p1')
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((p) => p.name);
  });
}

/** Взять заголовок за название и дождаться, что перенос начался.
 *
 *  Возвращает точку захвата. Вести потом надо строго от неё по вертикали:
 *  уровень задаётся ГОРИЗОНТАЛЬНЫМ сдвигом от точки нажатия, и если тянуть по
 *  координате левого края подписи, на широком названии сдвиг перевалит порог —
 *  жест честно превратится в «вынести наружу». Локально ширина подписи была
 *  меньше порога, в CI шрифт шире, и сборка падала на подписи плашки. */
async function hold(page: Page, name: string) {
  const el = page.getByText(name, { exact: true }).first();
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(page.locator('.fixed.z-\\[70\\]'), 'перенос не стартовал — плашки нет').toBeVisible({
    timeout: 2000,
  });
  return at;
}

test('подпроект переезжает выше своего соседа', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);
  expect(await order(page)).toEqual(['Поставщики', 'Реклама', 'Отчёты']);

  const at = await hold(page, 'Отчёты');
  // Ведём строго вертикально ОТ ТОЧКИ ЗАХВАТА: горизонталь меняла бы уровень.
  const target = (await page.getByText('Поставщики', { exact: true }).first().boundingBox())!;
  await page.mouse.move(at.x, target.y - 6, { steps: 12 });
  await page.waitForTimeout(200);
  await page.mouse.up();

  await expect.poll(() => order(page)).toEqual(['Отчёты', 'Поставщики', 'Реклама']);
});

test('пока подпроект остаётся внутри папки, подпись обещает порядок, а не «останется здесь»', async ({
  page,
}) => {
  await openApp(page, '/tasks');
  await seed(page);

  const at = await hold(page, 'Реклама');
  const target = (await page.getByText('Поставщики', { exact: true }).first().boundingBox())!;
  await page.mouse.move(at.x, target.y - 6, { steps: 12 });

  await expect(page.locator('.fixed.z-\\[70\\]')).toContainText('Поменяет порядок');
  await page.mouse.up();
});

test('отпустить там же, где взял, — порядок не трогается', async ({ page }) => {
  // Обратная сторона новой ветки: она не должна писать в базу от неподвижного
  // удержания. Лишний updatedAt разошёлся бы синком как перестановка, которой
  // не было.
  await openApp(page, '/tasks');
  await seed(page);
  const before = await order(page);

  await hold(page, 'Реклама');
  await page.mouse.up();
  await page.waitForTimeout(300);

  expect(await order(page)).toEqual(before);
});
