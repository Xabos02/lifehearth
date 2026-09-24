import { test, expect, openApp } from './fixtures';
import type { Page } from '@playwright/test';

// «Обучение»: то, что юнитом модели (lib/learningPace.test.ts) не поймать, —
// экраны и провод от шита плана до базы. Находки сквозного прогона 17.09:
// экран удалённого материала оставался открытым; на карточке без срока
// прогресс стоял дважды; отметка плана без оценок обнуляла прогресс; план
// «3 + 5» у материала в процентах ставил шкалу из восьми. И правило, которое
// первая починка нарушила: действие с планом не меняет то, что человек ввёл
// руками и что к действию не относится, — цель после отметки, прогресс после
// правки плана.
//
// Срок есть только у теста «финиша», и часы там прибиты (page.clock до
// openApp): остальные проверки от сегодняшней даты не зависят.

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

const part = (itemId: string, id: string, title: string, i: number, extra: Record<string, unknown> = {}) => ({
  ...row(id), itemId, title, section: '', estimate: 0, doneAt: null, sortOrder: i, ...extra,
});

async function seed(page: Page, items: unknown[], parts: unknown[] = [], logs: unknown[] = []) {
  await page.evaluate(
    async ({ items, parts, logs }) => {
      const { db } = await import('/src/db/db.ts');
      await db.learningItems.bulkPut(items as never[]);
      await db.learningParts.bulkPut(parts as never[]);
      await db.learningLogs.bulkPut(logs as never[]);
    },
    { items, parts, logs },
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
    material('l-pct', 'Английский', { kind: 'language', progressUnit: 'percent', progressTarget: 100, progressCurrent: 20 }),
  ]);
  await page.goto('/more/learning/l-pct');
  await page.getByRole('button', { name: 'Составить план', exact: true }).click();
  await page.getByRole('textbox').fill('Тема А — 3\nТема Б — 5');
  await page.getByRole('button', { name: 'Сохранить план', exact: true }).click();
  // Шит закрывается после записи в базу — читаем итог самого сохранения. Опрос
  // здесь не годится: засеянные {100, 20} совпали бы с ответом ещё до записи.
  // Прогресс засеян не нулём: в плане ещё ничего не закрыто, и 20%, отмеченные
  // руками, сохранение плана не обнуляет — с нулём этого было бы не отличить.
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(await progressOf(page, 'l-pct')).toEqual({ target: 100, current: 20 });

  // Оценка у процентов — вес части, а не проценты: «3 %» в строке соврало бы.
  const first = page.getByRole('button', { name: /^Тема А/ });
  await expect(first).toHaveText('Тема А3');
  await first.click();
  // Часть весом 3 из 8 — 38%; было: шкала 8 и «3%».
  await expect.poll(() => progressOf(page, 'l-pct')).toEqual({ target: 100, current: 38 });
});

test('отметка части не сбрасывает цель, поправленную руками после плана', async ({ page }) => {
  await openApp(page, '/more/learning');
  // Курс на 350 ч, в плане пока три дисциплины на 16,7 ч: цель 350 человек
  // вернул руками после сохранения плана.
  await seed(
    page,
    [material('l-hours', 'Курс в часах', { kind: 'course', progressUnit: 'hours', progressTarget: 350, progressCurrent: 0 })],
    [
      part('l-hours', 'd1', 'Дисциплина 1', 0, { estimate: 5.4 }),
      part('l-hours', 'd2', 'Дисциплина 2', 1, { estimate: 7.1 }),
      part('l-hours', 'd3', 'Дисциплина 3', 2, { estimate: 4.2 }),
    ],
  );
  await page.goto('/more/learning/l-hours');
  const first = page.getByRole('button', { name: /^Дисциплина 1/ });
  // Число и единица — через неразрывный пробел (§7.5). toHaveText приводит
  // пробелы к обычным и разницы не видит — сверяем сырой текст.
  await expect(first).toBeVisible();
  expect(await first.textContent()).toBe('Дисциплина 15,4\u00A0ч');
  await first.click();
  // Отметка двигает прогресс, цель остаётся 350; было {16,7; 5,4}.
  await expect.poll(() => progressOf(page, 'l-hours')).toEqual({ target: 350, current: 5.4 });
});

test('правка плана не откатывает прогресс, добавленный после отметки', async ({ page }) => {
  await openApp(page, '/more/learning');
  // Книга 340 стр., закрыта глава 1 из 3 (это 113), степпером дочитано до 163.
  await seed(
    page,
    [material('l-edit', 'Книга с главами', { progressCurrent: 163 })],
    [
      part('l-edit', 'e1', 'Глава 1', 0, { doneAt: '2026-09-20' }),
      part('l-edit', 'e2', 'Глава 2', 1),
      part('l-edit', 'e3', 'Глава 3', 2),
    ],
  );
  await page.goto('/more/learning/l-edit');
  await page.getByRole('button', { name: 'Изменить план', exact: true }).click();
  await page.getByRole('textbox').fill('Глава 1\nГлава 2. Основы\nГлава 3');
  await page.getByRole('button', { name: 'Сохранить план', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Глава 2. Основы', exact: true })).toBeVisible();
  // Переименование к прогрессу не относится: 163 остаются; было 113. Засеянное
  // совпадает с ответом, поэтому читаем после закрытия шита, а не опросом.
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(await progressOf(page, 'l-edit')).toEqual({ target: 340, current: 163 });
});

test('проценты, испорченные старым планом, чинятся при открытии', async ({ page }) => {
  await openApp(page, '/more/learning');
  // Старый план «3 + 5» ставил материалу в процентах цель 8: карточка
  // показывала «3%» при полосе на 37,5%. Та же доля на шкале 100 — 38%.
  const broken = { kind: 'language', progressUnit: 'percent', progressTarget: 8, progressCurrent: 3 };
  await seed(page, [material('l-old', 'Испанский', broken)]);
  await page.goto('/more/learning');
  await expect.poll(() => progressOf(page, 'l-old')).toEqual({ target: 100, current: 38 });
  await expect(page.getByText('38%', { exact: true }).first()).toBeVisible();

  // Экран материала, открытый напрямую (перезагрузка на нём, тихое
  // обновление), чинит так же — список мог и не открываться.
  await seed(page, [material('l-old2', 'Итальянский', broken)]);
  await page.goto('/more/learning/l-old2');
  await expect(page.getByRole('heading', { name: 'Итальянский', exact: true })).toBeVisible();
  await expect.poll(() => progressOf(page, 'l-old2')).toEqual({ target: 100, current: 38 });
});

test('«финиш» считает темп в единицах материала, а не в часах занятий', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-24T10:00:00'));
  await openApp(page, '/more/learning');
  // Курс: 14 уроков из 20 за 28 дней, срок завтра; занятий — по часу в неделю.
  const hour = (id: string, date: string) => ({ ...row(id), itemId: 'l-fin', date, value: 14, minutes: 60, note: '' });
  await seed(
    page,
    [
      material('l-fin', 'Курс со сроком', {
        kind: 'course',
        progressUnit: 'lessons',
        progressTarget: 20,
        progressCurrent: 14,
        startedAt: '2026-08-27T09:00:00.000Z',
        dueDate: '2026-09-25',
      }),
    ],
    [],
    [hour('s1', '2026-09-03'), hour('s2', '2026-09-10'), hour('s3', '2026-09-17'), hour('s4', '2026-09-24')],
  );
  await page.goto('/more/learning/l-fin');
  // Темп — 3,5 урока в неделю: остаток 6 закончится 6 октября, на 2 недели
  // позже срока. По часам занятий (1 ч в неделю как «1 урок») вышло бы +6.
  await expect(page.getByText('+2 нед. к сроку', { exact: true })).toBeVisible();
  // Месяц и год финиша — один абзац плитки, год отбит отступом, не пробелом.
  await expect(page.getByText('окт.2026', { exact: true })).toBeVisible();
});
