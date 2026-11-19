import { test, expect, openApp, answerConfirm } from './fixtures';
import type { Page } from '@playwright/test';

// Мелкие находки раздела «Здоровье» из аудита 1.64.0, которые чинятся без
// нового вида: H3, H12, H14, H17.

const SHEET = 'body > div.fixed.inset-0.z-50';

test('форма замера показывает записанное за выбранный день, набранное не трогает (H3)', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-16T12:00:00'));
  await openApp(page, '/more/health');
  await page.evaluate(async () => {
    const { logMeasure } = await import('/src/features/health/measures.ts');
    await logMeasure('weight', '2026-09-15', 84.5);
  });
  await page.getByRole('button', { name: 'Замеры' }).click();
  const card = page.getByTestId('measure-weight');
  const sheet = page.locator(SHEET);
  const field = sheet.getByPlaceholder('75');

  await card.getByRole('button', { name: '+ замер' }).click();
  await expect(field).toHaveValue('');
  await sheet.locator('input[type="date"]').fill('2026-09-15');
  await expect(field).toHaveValue('84,5');
  await expect(sheet.getByRole('button', { name: 'Удалить замер за этот день' })).toBeVisible();
  // Другой день без замера — подставленное уходит.
  await sheet.locator('input[type="date"]').fill('2026-09-16');
  await expect(field).toHaveValue('');

  // Поправка опечатки — в тот же день.
  await sheet.locator('input[type="date"]').fill('2026-09-15');
  await field.fill('84');
  await sheet.getByRole('button', { name: 'Сохранить' }).click();
  await expect(sheet).toHaveCount(0);
  const logs = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.metricLogs.toArray()).filter((l) => !l.deletedAt).map((l) => [l.date, l.value]);
  });
  expect(logs).toEqual([['2026-09-15', 84]]);

  // Набранное раньше смены дня не заменяется записанным.
  await card.getByRole('button', { name: '+ замер' }).click();
  await field.fill('90');
  await sheet.locator('input[type="date"]').fill('2026-09-15');
  await expect(field).toHaveValue('90');
});

test('«+ Своё: бег» выбирает встроенный бег, а не заводит второй (H12)', async ({ page }) => {
  await openApp(page, '/more/health');
  const sheet = page.locator(SHEET);
  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  await sheet.getByRole('button', { name: 'Силовая', exact: true }).click();
  await sheet.getByRole('button', { name: '+ Своё' }).click();
  await sheet.getByPlaceholder('Название вида').fill('Бег ');
  await sheet.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Бег', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.getByRole('button', { name: 'Бег', exact: true })).toHaveCount(1);
  await expect(sheet.locator('label', { hasText: 'Дистанция, км' })).toBeVisible();
  const defs = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return db.exerciseDefs.count();
  });
  expect(defs).toBe(0);
});

const CSV = [
  'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Moving Time',
  '1,"Sep 1, 2026, 7:01:00 AM","Morning Run",Run,2100,5.21,1920',
  '2,"Sep 3, 2026, 6:02:11 PM","Gym",Weight Training,3300,,3300',
].join('\n');

const alive = (page: Page) =>
  page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.workouts.toArray()).filter((w) => !w.deletedAt).length;
  });

test('импорт CSV отменяется кнопкой «Вернуть», и тот же файл потом импортируется снова (H14)', async ({ page }) => {
  await openApp(page, '/more/health');
  const importFile = () =>
    page.getByTestId('workout-csv').setInputFiles({ name: 'activities.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });

  await importFile();
  await answerConfirm(page, true);
  await expect.poll(() => alive(page)).toBe(2);
  await page.getByRole('button', { name: 'Вернуть' }).click();
  await expect.poll(() => alive(page)).toBe(0);

  // Отменённая пачка не считается «уже есть».
  await importFile();
  await answerConfirm(page, true);
  await expect.poll(() => alive(page)).toBe(2);
});

test('«Сохранить» в нетронутом шаблоне не пишет в базу (H17)', async ({ page }) => {
  await openApp(page, '/more/health');
  const stamp = await page.evaluate(async () => {
    const { addTemplate } = await import('/src/features/health/templateRepo.ts');
    const tpl = await addTemplate({ name: 'Ноги', items: [{ type: 'strength', customLabel: null, customColor: null, minutes: 40, distanceKm: null, exercises: [] }] } as never);
    return tpl.updatedAt;
  });
  await page.locator('header').getByRole('button', { name: 'Шаблоны', exact: true }).click();
  await page.getByRole('button', { name: 'Изменить шаблон «Ноги»' }).click();
  await page.locator(SHEET).getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator(SHEET).getByRole('heading', { name: 'Шаблоны тренировок' })).toBeVisible();
  const after = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.workoutTemplates.toArray())[0].updatedAt;
  });
  expect(after).toBe(stamp);
});
