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
  await page.evaluate((name) => {
    const header = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(name),
    )!;
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

test('уход с экрана во время удержания не оставляет плашку', async ({ page }) => {
  // Второй путь к тому же: заголовок размонтирован раньше, чем сработал таймер.
  await openApp(page, '/tasks');
  await seed(page);

  await page.evaluate(() => {
    const header = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Бизнес'),
    )!;
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
