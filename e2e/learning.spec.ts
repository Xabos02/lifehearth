import { test, expect, openApp } from './fixtures';
import type { Page } from '@playwright/test';

// «Обучение»: то, что юнитом модели (lib/learningPace.test.ts) не поймать, —
// экраны и провод от шита плана до базы. Находки сквозного прогона 17.09:
// экран удалённого материала оставался открытым; на карточке без срока
// прогресс стоял дважды; отметка плана без оценок обнуляла прогресс; план
// «3 + 5» у материала в процентах ставил шкалу из восьми.
//
// Сроков здесь нет намеренно: без них проверки не зависят от сегодняшней даты.

const NOW = '2026-09-01T09:00:00.000Z';
const row = (id: string) => ({ id, createdAt: NOW, updatedAt: NOW, deletedAt: null });
const material = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  ...row(id),
  title,
  author: '',
  kind: 'book',
  status: 'inProgress',
  goalId: null,
  progressUnit: 'pages',
  progressTarget: 340,
  progressCurrent: 40,
  notes: '',
  startedAt: NOW,
  finishedAt: null,
  ...extra,
});

async function seed(page: Page, items: unknown[], parts: unknown[] = []) {
  await page.evaluate(
    async ({ items, parts }) => {
      const { db } = await import('/src/db/db.ts');
      await db.learningItems.bulkPut(items as never[]);
      await db.learningParts.bulkPut(parts as never[]);
    },
    { items, parts },
  );
}

const progressOf = (page: Page, id: string) =>
  page.evaluate(async (id) => {
    const { db } = await import('/src/db/db.ts');
    const item = (await db.learningItems.get(id))!;
    return { target: item.progressTarget, current: item.progressCurrent };
  }, id);

test('удалённый материал закрывает свой экран и возвращает к списку', async ({ page }) => {
  await openApp(page, '/more/learning');
  await seed(page, [material('l-del', 'Удаляемая книга')]);
  await page.goto('/more/learning/l-del');
  await expect(page.getByRole('heading', { name: 'Удаляемая книга', exact: true })).toBeVisible();

  page.on('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Изменить материал', exact: true }).click();
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();

  await expect(page).toHaveURL((url) => url.pathname === '/more/learning');
  await expect(page.getByRole('heading', { name: 'Обучение', exact: true })).toBeVisible();
  await expect(page.getByText('Удаляемая книга', { exact: true })).toHaveCount(0);
});

test('на карточке без срока прогресс виден один раз', async ({ page }) => {
  await openApp(page, '/more/learning');
  await seed(page, [material('l-card', 'Книга без срока')]);
  await page.goto('/more/learning');
  await expect(page.getByText('Книга без срока', { exact: true })).toBeVisible();
  // Было «стр. 40 из 340» слева и справа; слева теперь «Без срока», как на
  // артборде design/learning/List.
  await expect(page.getByText('стр. 40 из 340', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Без срока', { exact: true })).toBeVisible();
});

test('отметка плана без оценок двигает прогресс, а не обнуляет его', async ({ page }) => {
  await openApp(page, '/more/learning');
  const chapter = (id: string, title: string, i: number) => ({
    ...row(id), itemId: 'l-plan', title, section: '', estimate: 0, doneAt: null, sortOrder: i,
  });
  await seed(
    page,
    [material('l-plan', 'Книга с главами')],
    [chapter('c1', 'Глава 1', 0), chapter('c2', 'Глава 2', 1), chapter('c3', 'Глава 3', 2)],
  );
  await page.goto('/more/learning/l-plan');
  await page.getByRole('button', { name: 'Глава 1', exact: true }).click();
  // Одна глава из трёх — треть от 340 страниц; было 0.
  await expect.poll(() => progressOf(page, 'l-plan')).toEqual({ target: 340, current: 113 });
});

test('план с оценками у материала в процентах оставляет шкалу 100', async ({ page }) => {
  await openApp(page, '/more/learning');
  await seed(page, [
    material('l-pct', 'Английский', { kind: 'language', progressUnit: 'percent', progressTarget: 100, progressCurrent: 0 }),
  ]);
  await page.goto('/more/learning/l-pct');
  await page.getByRole('button', { name: 'Составить план', exact: true }).click();
  await page.getByRole('textbox').fill('Тема А — 3\nТема Б — 5');
  await page.getByRole('button', { name: 'Сохранить план', exact: true }).click();
  // Шит закрывается после записи в базу — читаем итог самого сохранения. Опрос
  // здесь не годится: засеянные {100, 0} совпали бы с ответом ещё до записи.
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(await progressOf(page, 'l-pct')).toEqual({ target: 100, current: 0 });

  // Оценка у процентов — вес части, а не проценты: «3 %» в строке соврало бы.
  const first = page.getByRole('button', { name: /^Тема А/ });
  await expect(first).toHaveText('Тема А3');
  await first.click();
  // Часть весом 3 из 8 — 38%; было: шкала 8 и «3%».
  await expect.poll(() => progressOf(page, 'l-pct')).toEqual({ target: 100, current: 38 });
});
