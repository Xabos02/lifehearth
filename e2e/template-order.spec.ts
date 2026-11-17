import { test, expect, openApp, type Page } from './fixtures';

// Порядок шаблонов тренировок — удержанием строки и переносом (канва
// design/template-order, вариант А, 17.11.2026). Владелец: «Сделать, чтобы
// можно было менять шаблоны тренировок местами». До этого шаблоны стояли по
// алфавиту — и в списке, и чипами «По шаблону» в карточке дня. Жест — тот же,
// что у папок «Заметок» и проектов «Задач»: 400 мс без движения, потом вести.

const kind = { type: 'strength', customLabel: null, customColor: null, minutes: 0, distanceKm: null, exercises: [] };

/** Шаблоны «до обновления» — без поля порядка. */
async function seedOld(page: Page, names: string[]) {
  await page.evaluate(
    async ({ names, kind }) => {
      const { db } = await import('/src/db/db.ts');
      const now = new Date().toISOString();
      await db.workoutTemplates.bulkPut(
        names.map((name, i) => ({ id: `t${i}`, name, items: [kind], createdAt: now, updatedAt: now, deletedAt: null })) as never[],
      );
    },
    { names, kind },
  );
}

/** Порядок в базе — как его видит приложение. */
const stored = (page: Page) =>
  page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { byTemplateOrder } = await import('/src/features/health/templateRepo.ts');
    return (await db.workoutTemplates.toArray()).sort(byTemplateOrder).map((t) => [t.name, t.sortOrder ?? null]);
  });

const chips = (page: Page) =>
  page.getByTestId('day-templates').getByRole('button', { name: /^По шаблону:/ }).evaluateAll((els) =>
    els.map((el) => el.getAttribute('aria-label')!.replace('По шаблону: ', '')),
  );

const rowNames = (page: Page) =>
  page.locator('[data-template-id] span.font-medium').allTextContents();

async function openList(page: Page) {
  await page.locator('header').getByRole('button', { name: 'Шаблоны', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Шаблоны тренировок' })).toBeVisible();
  // Координаты строк — только когда шторка доехала: на въезде нажатие
  // попадало мимо строки (тот же приём, что sheetsAtRest в touch.spec).
  await page.evaluate(async () => {
    await Promise.all([...document.querySelectorAll('[class*="animate-sheet-up"]')]
      .flatMap((el) => el.getAnimations())
      .map((a) => a.finished));
  });
}

/** Нажать строку шаблона и держать дольше порога (400 мс). */
async function hold(page: Page, name: string) {
  const box = (await page.getByRole('button', { name: new RegExp(`^${name}`) }).boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(page.getByTestId('template-ghost')).toBeVisible();
  return at;
}

const rowTops = (page: Page) =>
  page.locator('[data-template-id]').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));

test('перенос удержанием: порядок общий для списка и чипов карточки дня, список под пальцем не сдвигается', async ({ page }) => {
  await openApp(page, '/more/health');
  await seedOld(page, ['Тренировка Б', 'Контрольный день', 'Тренировка А']);
  // Старые шаблоны после обновления стоят, как стояли, — по алфавиту.
  await expect.poll(() => chips(page)).toEqual(['Контрольный день', 'Тренировка А', 'Тренировка Б']);

  await openList(page);
  await expect(page.getByText('Удерживайте шаблон, чтобы переставить.', { exact: false })).toBeVisible();
  expect(await rowNames(page)).toEqual(['Контрольный день', 'Тренировка А', 'Тренировка Б']);
  const before = await rowTops(page);

  const from = await hold(page, 'Контрольный день');
  const last = (await page.locator('[data-template-id]').last().boundingBox())!;
  await page.mouse.move(from.x, last.y + last.height - 4, { steps: 10 });
  // Линия — у нижнего края последней строки, строка на старом месте погашена,
  // а сами строки не сдвинулись ни на пиксель: линия поверх, без своей высоты.
  const line = page.getByTestId('template-drop-line');
  await expect(line).toHaveCount(1);
  await expect(page.locator('[data-template-id]').last().getByTestId('template-drop-line')).toHaveCount(1);
  expect(await rowTops(page)).toEqual(before);
  await page.mouse.up();

  await expect(page.getByTestId('template-ghost')).toHaveCount(0);
  await expect(line).toHaveCount(0);
  await expect.poll(() => rowNames(page)).toEqual(['Тренировка А', 'Тренировка Б', 'Контрольный день']);
  // Первый перенос нумерует весь список ровным шагом.
  await expect.poll(() => stored(page)).toEqual([
    ['Тренировка А', 1000],
    ['Тренировка Б', 2000],
    ['Контрольный день', 3000],
  ]);
  // Прокрутка страницы после жеста снова разрешена.
  expect(await page.evaluate(() => document.body.style.touchAction)).toBe('');

  await page.locator('body > div.fixed.inset-0.z-50').getByRole('button', { name: 'Закрыть' }).click();
  await expect.poll(() => chips(page)).toEqual(['Тренировка А', 'Тренировка Б', 'Контрольный день']);
});

test('удержание без движения ничего не меняет и не выбирает шаблон; тап выбирает', async ({ page }) => {
  await openApp(page, '/more/health');
  await seedOld(page, ['Тренировка А', 'Тренировка Б']);
  await openList(page);

  await hold(page, 'Тренировка Б');
  await page.mouse.up();
  await expect(page.getByTestId('template-ghost')).toHaveCount(0);
  await page.waitForTimeout(300);
  // Удержание не тап: форма тренировки по шаблону не открылась (заголовок у
  // неё — имя шаблона, под ним пометка), список на месте, порядок не тронут.
  await expect(page.getByText('Новая тренировка по шаблону')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Шаблоны тренировок' })).toBeVisible();
  expect(await stored(page)).toEqual([
    ['Тренировка А', null],
    ['Тренировка Б', null],
  ]);

  await page.getByRole('button', { name: /^Тренировка Б/ }).click();
  await expect(page.getByText('Новая тренировка по шаблону')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
});

test('обрыв жеста системой — переноса нет', async ({ page }) => {
  await openApp(page, '/more/health');
  await seedOld(page, ['Тренировка А', 'Тренировка Б', 'Тренировка В']);
  await openList(page);
  await page.evaluate(() => {
    window.addEventListener('pointerdown', (e) => ((window as unknown as { __pid: number }).__pid = e.pointerId), { capture: true });
  });

  const from = await hold(page, 'Тренировка А');
  const last = (await page.locator('[data-template-id]').last().boundingBox())!;
  await page.mouse.move(from.x, last.y + last.height - 4, { steps: 10 });
  await expect(page.getByTestId('template-drop-line')).toHaveCount(1);
  // Звонок или шторка уведомлений: браузер шлёт pointercancel вместо pointerup.
  await page.evaluate(() => {
    const pointerId = (window as unknown as { __pid: number }).__pid;
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId }));
  });
  await expect(page.getByTestId('template-ghost')).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await rowNames(page)).toEqual(['Тренировка А', 'Тренировка Б', 'Тренировка В']);
  expect((await stored(page)).map(([, order]) => order)).toEqual([null, null, null]);
  expect(await page.evaluate(() => document.body.style.touchAction)).toBe('');
});

test('новый шаблон встаёт первым; при одном шаблоне про перенос не пишем', async ({ page }) => {
  await openApp(page, '/more/health');
  await seedOld(page, ['Тренировка А']);
  await openList(page);
  await expect(page.getByText('Выберите шаблон — тренировка заполнится сама. Карандаш — изменить.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Новый шаблон' }).click();
  await page.getByLabel('Название шаблона').fill('Ярмарка');
  await page.getByRole('button', { name: 'Сохранить шаблон' }).click();
  await expect(page.getByRole('heading', { name: 'Шаблоны тренировок' })).toBeVisible();
  // «Ярмарка» по алфавиту была бы последней — встала первой.
  await expect.poll(() => rowNames(page)).toEqual(['Ярмарка', 'Тренировка А']);
  await expect(page.getByText('Удерживайте шаблон, чтобы переставить.', { exact: false })).toBeVisible();
});

test('длинный список: у нижнего края шторка докручивается сама, шаблон уезжает за первый экран', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openApp(page, '/more/health');
  await seedOld(page, Array.from({ length: 14 }, (_, i) => `Шаблон ${String(i + 1).padStart(2, '0')}`));
  await openList(page);
  const panel = page.locator('[class*="animate-sheet-up"]');
  expect(await panel.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  const from = await hold(page, 'Шаблон 01');
  // Палец у нижнего края шторки — в зоне разгона: прокрутка пальцем на время
  // жеста заблокирована, шторка едет сама.
  const box = (await panel.boundingBox())!;
  await page.mouse.move(from.x, box.y + box.height - 12, { steps: 10 });
  await expect.poll(() => panel.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBeGreaterThan(200);
  await page.mouse.up();

  // Встал далеко за первым экраном, а не там, где был палец до прокрутки.
  await expect.poll(async () => (await stored(page)).findIndex(([name]) => name === 'Шаблон 01')).toBeGreaterThan(8);
});
