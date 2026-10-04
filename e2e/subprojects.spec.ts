import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Перенос подпроекта удержанием заголовка.
//
// Раньше подпроект нельзя было сдвинуть вовсе: машинка удержания жила только
// внутри секции верхнего уровня. Единственным способом вынести подпроект
// наружу было открыть его настройки и снять родителя вручную.
//
// Уровень задаётся ГОРИЗОНТАЛЬЮ пальца, как отступ в списке файлов: тянешь
// влево — подпроект становится отдельным проектом, вправо — вкладывается.

async function seed(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null },
      { ...base('p2'), name: 'Здоровье', color: '#3aa35e', emoji: '🏃', sortOrder: 2000, archivedAt: null },
      { ...base('s1'), name: 'Поставщики', color: '#e0803a', emoji: '📦', sortOrder: 1100, archivedAt: null, parentId: 'p1' },
    ]);
  });
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Задачи' })).toBeVisible();
  await expect(page.getByText('Поставщики')).toBeVisible();
}

/** Удержание заголовка и перенос пальцем в заданную точку. */
async function dragHeader(page: Page, title: string, to: { x: number; y: number }) {
  const header = page.getByText(title, { exact: true }).first();
  // hover, а не mouse.move по координатам: он сам доскроллит до элемента и
  // дождётся, пока тот перестанет быть перекрытым. С голым mouse.move события
  // просто не доходили — заголовок был ниже видимой области, а Playwright для
  // низкоуровневой мыши не скроллит и перекрытие не проверяет.
  await header.scrollIntoViewIfNeeded();
  await header.hover();
  await page.mouse.down();
  // Удержание — 400мс; ждём с запасом, но НЕ двигая мышь: сдвиг отменяет жест.
  await page.waitForTimeout(650);
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.waitForTimeout(150);
  return async () => {
    await page.mouse.up();
    await page.waitForTimeout(400);
  };
}

/** Родитель подпроекта в базе. */
async function parentOf(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const { db } = await import('/src/db/db.ts');
    return (await db.projects.get(id))?.parentId ?? null;
  }, id);
}

test('подпроект, вытянутый влево, становится отдельным проектом', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);
  expect(await parentOf(page, 's1')).toBe('p1');

  const drop = await dragHeader(page, 'Поставщики', { x: 20, y: 300 });
  await expect(page.getByText('Станет отдельным проектом')).toBeVisible();
  await drop();

  expect(await parentOf(page, 's1')).toBeNull();
});

test('подсказка на плашке говорит, что будет ДО отпускания', async ({ page }) => {
  // Горизонталь — вещь неочевидная: без подписи человек отпускает и узнаёт
  // результат постфактум.
  await openApp(page, '/tasks');
  await seed(page);

  const drop = await dragHeader(page, 'Поставщики', { x: 20, y: 300 });
  await expect(page.getByText('Станет отдельным проектом')).toBeVisible();
  // Уводим палец вправо — подсказка обязана смениться на месте.
  await page.mouse.move(300, 300, { steps: 8 });
  await page.waitForTimeout(200);
  await expect(page.getByText('Станет отдельным проектом')).toHaveCount(0);
  await drop();
});

test('перенос отменяется, если палец поехал сразу, — это скролл', async ({ page }) => {
  // Иначе список нельзя было бы прокрутить: любое касание заголовка начинало
  // бы перенос.
  await openApp(page, '/tasks');
  await seed(page);
  const header = page.getByText('Поставщики', { exact: true }).first();
  await header.scrollIntoViewIfNeeded();
  await header.hover();
  const box = (await header.boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 6 }); // сразу поехали
  await page.waitForTimeout(650);
  await page.mouse.up();

  expect(await parentOf(page, 's1')).toBe('p1');
});

test('проект верхнего уровня можно вложить в другой', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);
  expect(await parentOf(page, 'p2')).toBeNull();

  // Тянем «Здоровье» вправо, на территорию «Бизнеса».
  // Координаты «Бизнеса» берём ПОСЛЕ начала переноса: dragHeader доскроллит до
  // «Здоровья», и всё, что померили заранее, уже сдвинулось.
  const header = page.getByText('Здоровье', { exact: true }).first();
  await header.scrollIntoViewIfNeeded();
  await header.hover();
  await page.mouse.down();
  await page.waitForTimeout(650);

  // +80, а не +20: у самой верхней кромки секции палец читается как «вставить
  // перед ней», и подсказка честно пишет «Поменяет порядок». Вложение — это
  // тело секции, а не её край.
  const bizBox = (await page.getByText('Бизнес', { exact: true }).first().boundingBox())!;
  await page.mouse.move(300, bizBox.y + 80, { steps: 12 });
  await page.waitForTimeout(200);
  await expect(page.getByText(/Внутрь «Бизнес»/)).toBeVisible();
  await page.mouse.up();
  await page.waitForTimeout(400);

  expect(await parentOf(page, 'p2')).toBe('p1');
});

test('удержание БЕЗ движения ничего не меняет', async ({ page }) => {
  // Самая дорогая находка аудита: уровень считался по абсолютной горизонтали,
  // а шеврон и папка подпроекта лежат левее порога. Подержал палец на
  // заголовке, отпустил на месте — и подпроект уехал на верхний уровень и в
  // конец списка, хотя человек ничего не тянул.
  await openApp(page, '/tasks');
  await seed(page);

  const el = page.getByText('Поставщики', { exact: true }).first();
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  // Целимся ЛЕВЕЕ текста — туда, где шеврон и папка: ровно та зона, где
  // абсолютный порог давал ложное «вынести наружу».
  await page.mouse.move(box.x - 24, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(400);

  expect(await parentOf(page, 's1')).toBe('p1');
});

test('проект, взятый за НАЗВАНИЕ, меняет порядок, а не вкладывается', async ({ page }) => {
  // Название начинается примерно с 68px, порог был 64px — то есть взявший
  // папку за имя (самая крупная и очевидная цель) вместо смены порядка
  // вкладывал её в соседнюю.
  await openApp(page, '/tasks');
  await seed(page);

  const health = page.getByText('Здоровье', { exact: true }).first();
  await health.scrollIntoViewIfNeeded();
  const box = (await health.boundingBox())!;
  // Берём точно за середину названия и тянем ТОЛЬКО вверх, без сдвига вбок.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  const biz = (await page.getByText('Бизнес', { exact: true }).first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, biz.y - 10, { steps: 12 });
  await page.waitForTimeout(200);
  await expect(page.getByText('Поменяет порядок')).toBeVisible();
  await page.mouse.up();
  await page.waitForTimeout(400);

  expect(await parentOf(page, 'p2')).toBeNull();
});

test('при вложении линия вставки не спорит с подсказкой', async ({ page }) => {
  // Пока проект вкладывается, порядок не применяется вовсе — finish кладёт его
  // в конец списка нового родителя. А линия вставки рисовалась всё равно, и
  // человек видел два взаимоисключающих обещания разом: «встанет сюда» между
  // папками и «Внутрь «Бизнес»» на плашке. Это же и маскировало саму подмену
  // жеста: до отпускания он выглядел переупорядочиванием.
  await openApp(page, '/tasks');
  await seed(page);

  const health = page.getByText('Здоровье', { exact: true }).first();
  await health.scrollIntoViewIfNeeded();
  await health.hover();
  await page.mouse.down();
  await page.waitForTimeout(650);
  // Якорь: пока жест — смена порядка, линия есть. Без него проверка ниже
  // молча слепнет, стоит линии сменить разметку, — так уже было, когда она
  // искалась по классу тени, снятому из интерфейса.
  await expect(page.getByTestId('project-drop-line')).toHaveCount(1);

  const box = (await health.boundingBox())!;
  const biz = (await page.getByText('Бизнес', { exact: true }).first().boundingBox())!;
  // Явный сдвиг вправо — режим вложения.
  await page.mouse.move(box.x + 140, biz.y + 80, { steps: 12 });
  await page.waitForTimeout(250);

  await expect(page.getByText(/Внутрь «Бизнес»/)).toBeVisible();
  // Линии вставки при этом быть не должно ни одной.
  await expect(page.getByTestId('project-drop-line')).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(400);
  expect(await parentOf(page, 'p2')).toBe('p1');
});
