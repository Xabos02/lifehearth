import { test, expect, openApp } from './fixtures';

// Серые дни по краям сетки — дни соседних месяцев. Тап по такому дню выбирал
// его, но месяц оставался прежним: выбранный день висел серым на краю, а
// задачи под сеткой были уже другого месяца (сквозной прогон 13–17.09).
// Комментарий в коде при этом обещал «переводят календарь на тот месяц».
//
// Часы прибиты: сетка сентября 2026 начинается с понедельника 31 августа и
// кончается воскресеньем 4 октября — оба края в ней есть всегда.

test('тап по дню соседнего месяца листает календарь на этот месяц', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-15T12:00:00'));
  await openApp(page, '/calendar');
  const month = page.getByRole('heading', { level: 2 }).first();
  await expect(month).toHaveText('Сентябрь 2026');

  await page.getByRole('button', { name: /^31 августа 2026/ }).click();
  await expect(month).toHaveText('Август 2026');
  await expect(page.getByRole('button', { name: /^31 августа 2026, выбрано/ })).toHaveAttribute('aria-pressed', 'true');

  // И вперёд: из августа — в сентябрь по серому дню хвоста сетки.
  await page.getByRole('button', { name: /^1 сентября 2026/ }).click();
  await expect(month).toHaveText('Сентябрь 2026');
});
