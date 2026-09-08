import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Перетаскивание проекта не должно начинаться без пальца.
//
// Удержание заголовка вооружает таймер на 400 мс, и он запускает перенос.
// Снимался таймер только обработчиком на самом заголовке — а отпускание не
// всегда туда попадает: палец соскользнул на соседний элемент, строку
// перерисовало, экран сменился. Тогда таймер срабатывал уже после того, как
// касание закончилось: перенос стартовал без пальца, плашка-«призрак» с
// именем проекта приклеивалась к экрану, и убрать её было нечем — pointerup
// больше не придёт. Со стороны это выглядит как зависшее приложение.
//
// Хуже второе следствие: слушатели переноса ждут pointerup на окне, и следующий
// же тап человека прилетал им как «отпустил здесь» — проект переезжал сам, без
// единого жеста переноса.
//
// Тот же таймер в строке задачи снимается при размонтировании (TaskItem,
// «подстраховка»), в заголовке проекта эту подстраховку забыли.

const GHOST = '.fixed.z-\\[70\\]';

async function seed(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null },
      { ...base('p2'), name: 'Здоровье', color: '#3aa35e', emoji: '🏃', sortOrder: 2000, archivedAt: null },
      { ...base('p3'), name: 'Учёба', color: '#f59e0b', emoji: '📚', sortOrder: 3000, archivedAt: null },
    ]);
  });
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Задачи' })).toBeVisible();
}

/** Нажать на заголовок проекта и отпустить палец МИМО него.
 *
 *  pointerup уходит в body: до корня React он не доходит, значит обработчик
 *  заголовка его не увидит — ровно как на телефоне, когда палец соскользнул
 *  или строку перерисовало между нажатием и отпусканием. */
async function pressAndReleaseElsewhere(page: Page, name: string) {
  // Ждём сам заголовок, а не общий признак экрана: в CI список проектов
  // дорисовывается позже, и evaluate успевал не найти кнопку — тест падал на
  // undefined вместо того, чтобы проверять поведение.
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  await page.evaluate((name) => {
    const header = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(name),
    );
    if (!header) throw new Error(`заголовок «${name}» не найден на экране`);
    const r = header.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: r.left + 30,
      clientY: r.top + r.height / 2,
    };
    header.dispatchEvent(new PointerEvent('pointerdown', opts));
    document.body.dispatchEvent(new PointerEvent('pointerup', opts));
  }, name);
  // Дольше удержания: если таймер не снят, перенос успеет стартовать.
  await page.waitForTimeout(700);
}

test('отпускание мимо заголовка не запускает перенос', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);

  await pressAndReleaseElsewhere(page, 'Бизнес');

  await expect(page.locator(GHOST), 'плашка переноса висит без пальца').toHaveCount(0);
});

test('следующий тап не переносит проект сам собой', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);

  const order = async () =>
    page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      const ps = await db.projects.toArray();
      return ps.sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.name);
    });
  const before = await order();

  await pressAndReleaseElsewhere(page, 'Бизнес');
  // Обычный тап в стороне — человек просто продолжил пользоваться приложением.
  await page.mouse.click(200, 700);
  await page.waitForTimeout(300);

  expect(await order()).toEqual(before);
});

test('строка задачи: отпускание мимо неё тоже не запускает перенос', async ({ page }) => {
  // Тот же провал, что у заголовков, но в строке задачи: разбор нашёл, что
  // сторожа отпускания на окне там не было вовсе. Обработчик строки видит
  // отпускание, только когда оно пришло в неё, — а палец соскальзывает на
  // соседнюю строку постоянно, строки высотой в сорок пикселей стоят вплотную.
  await openApp(page, '/tasks');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null },
    ]);
    await db.tasks.put({
      ...base('t1'), title: 'Позвонить поставщику', notes: '', projectId: 'p1', goalId: null,
      priority: 0, dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: 1000,
    } as never);
  });
  await page.goto('/tasks');
  await expect(page.getByText('Позвонить поставщику')).toBeVisible();

  await page.evaluate(() => {
    const row = document.querySelector('[data-task-id]');
    if (!row) throw new Error('строка задачи не найдена');
    const r = row.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true,
      clientX: r.left + 60, clientY: r.top + r.height / 2,
    };
    row.dispatchEvent(new PointerEvent('pointerdown', opts));
    document.body.dispatchEvent(new PointerEvent('pointerup', opts));
  });
  await page.waitForTimeout(700);

  await expect(page.locator(GHOST), 'плашка переноса задачи висит без пальца').toHaveCount(0);
});

test('уход с экрана во время удержания не оставляет плашку', async ({ page }) => {
  // Второй путь к тому же: заголовок размонтирован раньше, чем сработал таймер.
  await openApp(page, '/tasks');
  await seed(page);

  await expect(page.getByText('Бизнес', { exact: true }).first()).toBeVisible();
  await page.evaluate(() => {
    const header = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Бизнес'),
    );
    if (!header) throw new Error('заголовок «Бизнес» не найден на экране');
    const r = header.getBoundingClientRect();
    header.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        clientX: r.left + 30,
        clientY: r.top + r.height / 2,
      }),
    );
  });
  // Экран сменился, пока палец ещё лежал на заголовке.
  await page.getByRole('link', { name: 'Заметки' }).click();
  await page.waitForTimeout(700);
  await page.goBack();

  await expect(page.locator(GHOST), 'плашка пережила уход с экрана').toHaveCount(0);
});

// Чужой палец не завершает чужой жест.
//
// Слушатели переноса живут на ОКНЕ и принимали события от любого указателя:
// тащишь задачу, ладонь или второй большой палец касается экрана — его
// pointerup прилетает в обработчик завершения, и задача коммитится туда, где
// оказалась в этот момент, хотя первый палец ещё держит. На телефоне ладонь
// ложится на экран регулярно.
test('отпускание вторым пальцем не завершает перенос задачи', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    const task = (id: string, title: string, projectId: string, sortOrder: number) => ({
      ...base(id), title, notes: '', projectId, goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder,
    });
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null },
    ] as never[]);
    await db.tasks.bulkPut([
      task('t1', 'Первая', 'p1', 1000),
      task('t2', 'Вторая', 'p1', 2000),
      task('t3', 'Третья', 'p1', 3000),
    ] as never[]);
  });
  await page.goto('/tasks');
  await expect(page.getByText('Третья', { exact: true })).toBeVisible();

  const order = async () =>
    page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      const rows = await db.tasks.toArray();
      return rows.sort((a, b) => a.sortOrder - b.sortOrder).map((t) => t.title);
    });
  const before = await order();

  // Берём третью задачу и ведём её вверх — как настоящим пальцем.
  const el = page.getByText('Третья', { exact: true }).first();
  await el.scrollIntoViewIfNeeded();
  await el.hover();
  const box = (await el.boundingBox())!;
  await page.mouse.down();
  await expect(page.locator(GHOST), 'перенос не стартовал').toBeVisible({ timeout: 2000 });
  const target = (await page.getByText('Первая', { exact: true }).first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, target.y + 2, { steps: 10 });

  // Ладонь: посторонний указатель отпускается посреди жеста.
  await page.evaluate(() => {
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true, pointerId: 99, pointerType: 'touch', clientX: 10, clientY: 10,
      }),
    );
  });
  await page.waitForTimeout(200);

  expect(await order(), 'чужой палец завершил перенос').toEqual(before);
  await expect(page.locator(GHOST), 'плашка исчезла от чужого пальца').toBeVisible();

  // А свой — завершает как раньше.
  await page.mouse.up();
  await expect.poll(order).not.toEqual(before);
});
