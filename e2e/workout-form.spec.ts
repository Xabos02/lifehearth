import { test, expect, openApp, answerConfirm } from './fixtures';
import type { Page } from '@playwright/test';

// Форма тренировки (аудит 1.64.0: H20, H13, H2, H19): набранное не пропадает
// молча, занятие из нескольких видов переносится и удаляется целиком,
// новая запись начинается с последнего вида.

const SHEET = 'body > div.fixed.inset-0.z-50';
// Не getByLabel: у заполненного поля подпись достаётся крестику очистки.
const km = (page: Page) => page.locator(SHEET).locator('label', { hasText: 'Дистанция, км' }).locator('input');

type Seed = { id: string; date: string; type: string; minutes: number; groupId?: string | null; createdAt?: string };

async function seed(page: Page, rows: Seed[]) {
  await page.evaluate(async (list) => {
    const { db } = await import('/src/db/db.ts');
    for (const r of list) {
      const ts = r.createdAt ?? new Date().toISOString();
      await db.workouts.put({
        id: r.id, createdAt: ts, updatedAt: ts, deletedAt: null,
        date: r.date, type: r.type as never, minutes: r.minutes, distanceKm: null, effort: null, note: '',
        source: 'manual', groupId: r.groupId ?? null, customLabel: null, customColor: null,
      });
    }
  }, rows);
}

const stored = (page: Page) =>
  page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.workouts.toArray()).map((w) => ({ id: w.id, date: w.date, groupId: w.groupId ?? null, deleted: Boolean(w.deletedAt) }));
  });

test('набранное не закрывается молча: крестик спрашивает, нетронутая форма закрывается сразу', async ({ page }) => {
  await openApp(page, '/more/health');
  const sheet = page.locator(SHEET);

  // Нетронутая — без вопроса.
  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  await sheet.getByRole('button', { name: 'Закрыть' }).click();
  await expect(sheet).toHaveCount(0);

  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  await km(page).fill('7,5');
  await sheet.first().getByRole('button', { name: 'Закрыть' }).click();
  expect(await answerConfirm(page, false)).toContain('Закрыть без сохранения?');
  await expect(km(page)).toHaveValue('7,5');

  await sheet.getByRole('button', { name: 'Закрыть' }).click();
  await answerConfirm(page, true);
  await expect(sheet).toHaveCount(0);
  expect(await stored(page)).toEqual([]);

  // Сохранение закрывает форму мимо вопроса.
  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  await km(page).fill('5');
  await sheet.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);
});

test('«Из шаблона» поверх набранного спрашивает; нетронутую форму заполняет сразу', async ({ page }) => {
  await openApp(page, '/more/health');
  await page.evaluate(async () => {
    const { addTemplate } = await import('/src/features/health/templateRepo.ts');
    await addTemplate({
      name: 'Ноги',
      items: [{ type: 'strength', customLabel: null, customColor: null, minutes: 40, distanceKm: null, exercises: [{ name: 'Присед', sets: 4, reps: 8 }] }],
    } as never);
  });
  const sheet = page.locator(SHEET);
  const pickTemplate = async () => {
    await sheet.getByRole('button', { name: 'Из шаблона' }).click();
    await page.getByRole('button', { name: /^Ноги/ }).click();
  };

  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  await km(page).fill('7,5');
  await pickTemplate();
  expect(await answerConfirm(page, false)).toContain('Заменить набранное шаблоном?');
  await expect(km(page)).toHaveValue('7,5');

  await pickTemplate();
  await answerConfirm(page, true);
  await expect(sheet.getByRole('heading', { name: 'Ноги', exact: true })).toBeVisible();
  await expect(km(page)).toHaveCount(0);

  // Шаблон загружен, больше ничего не трогали — закрытие без вопроса.
  await sheet.getByRole('button', { name: 'Закрыть' }).click();
  await expect(sheet).toHaveCount(0);

  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  await pickTemplate();
  await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);
  await expect(sheet.getByRole('heading', { name: 'Ноги', exact: true })).toBeVisible();
});

test('занятие из двух видов переносится и удаляется целиком — или только один вид', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-16T12:00:00'));
  await openApp(page, '/more/health');
  await seed(page, [
    { id: 'a', date: '2026-09-16', type: 'strength', minutes: 45, groupId: 'g1', createdAt: '2026-09-16T10:00:00.000Z' },
    { id: 'b', date: '2026-09-16', type: 'stretch', minutes: 20, groupId: 'g1', createdAt: '2026-09-16T10:00:00.001Z' },
  ]);
  const sheet = page.locator(SHEET);

  // Перенос силовой на вчера — вопрос про всё занятие.
  await page.getByRole('button', { name: /^Силовая/ }).first().click();
  await sheet.locator('input[type="date"]').fill('2026-09-15');
  await sheet.getByRole('button', { name: 'Сохранить', exact: true }).click();
  expect(await answerConfirm(page, true)).toContain('Перенести всё занятие?');
  await expect(sheet).toHaveCount(0);
  expect(await stored(page)).toEqual([
    { id: 'a', date: '2026-09-15', groupId: 'g1', deleted: false },
    { id: 'b', date: '2026-09-15', groupId: 'g1', deleted: false },
  ]);
  const monthTile = page.getByText('тренировок за месяц', { exact: true }).locator('..');
  await expect(monthTile.locator('p').first()).toHaveText('1');

  // «Только этот вид» — как раньше: вид уходит отдельной тренировкой.
  await page.getByRole('button', { name: /^Растяжка/ }).first().click();
  await sheet.locator('input[type="date"]').fill('2026-09-14');
  await sheet.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await answerConfirm(page, false);
  await expect(sheet).toHaveCount(0);
  expect(await stored(page)).toEqual([
    { id: 'a', date: '2026-09-15', groupId: 'g1', deleted: false },
    { id: 'b', date: '2026-09-14', groupId: null, deleted: false },
  ]);

  // Удаление: сначала «удалить?», потом — всё занятие или один вид.
  await seed(page, [{ id: 'c', date: '2026-09-15', type: 'boxing', minutes: 30, groupId: 'g1', createdAt: '2026-09-15T10:00:00.002Z' }]);
  await page.getByRole('button', { name: /^Бокс/ }).first().click();
  await sheet.getByRole('button', { name: 'Удалить' }).click();
  expect(await answerConfirm(page, true)).toContain('Удалить тренировку?');
  expect(await answerConfirm(page, false)).toContain('Удалить всё занятие?');
  await expect(sheet).toHaveCount(0);
  expect((await stored(page)).filter((r) => r.deleted).map((r) => r.id)).toEqual(['c']);

  await page.getByRole('button', { name: /^Силовая/ }).first().click();
  await sheet.getByRole('button', { name: 'Удалить' }).click();
  await answerConfirm(page, true);
  // Последний вид занятия — второго вопроса нет.
  await expect(sheet).toHaveCount(0);
  expect((await stored(page)).filter((r) => r.deleted).map((r) => r.id).sort()).toEqual(['a', 'c']);

  // Занятие из двух живых видов удаляется целиком.
  await seed(page, [
    { id: 'd', date: '2026-09-16', type: 'run', minutes: 30, groupId: 'g2', createdAt: '2026-09-16T11:00:00.000Z' },
    { id: 'e', date: '2026-09-16', type: 'walk', minutes: 20, groupId: 'g2', createdAt: '2026-09-16T11:00:00.001Z' },
  ]);
  await page.getByRole('button', { name: /^Бег/ }).first().click();
  await sheet.getByRole('button', { name: 'Удалить' }).click();
  await answerConfirm(page, true);
  await answerConfirm(page, true);
  await expect(sheet).toHaveCount(0);
  expect((await stored(page)).filter((r) => r.deleted).map((r) => r.id).sort()).toEqual(['a', 'c', 'd', 'e']);
});

test('новая тренировка начинается с последнего вида, а не всегда с бега', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-16T12:00:00'));
  await openApp(page, '/more/health');
  await seed(page, [{ id: 'y', date: '2026-09-15', type: 'strength', minutes: 60 }]);
  const sheet = page.locator(SHEET);

  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  await expect(sheet.getByRole('button', { name: 'Силовая', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Минуты — по виду, а не с прошлой записи.
  await expect(sheet.getByPlaceholder('по желанию').first()).toHaveValue('45');
  await sheet.getByRole('button', { name: 'Закрыть' }).click();
  await expect(sheet).toHaveCount(0);

  // С «Сегодня» — так же.
  await page.goto('/');
  await page.getByTestId('sport-today').getByRole('button', { name: 'Отметить' }).click();
  await expect(sheet.getByRole('button', { name: 'Силовая', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
