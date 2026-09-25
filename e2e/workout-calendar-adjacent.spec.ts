import { test, expect, openApp } from './fixtures';

// Месячная сетка спорта: тап по серому дню соседнего месяца выбирал день, но
// сетка оставалась на прежнем месяце — выбранный день висел серым на краю, а
// сводка под сеткой была уже про другой месяц. «Календарь» задач так уже
// листает (calendar-adjacent-day.spec).
//
// Часы прибиты: сетка сентября 2026 начинается с понедельника 31 августа.
// Вперёд не проверяем — дни октября ещё не наступили и выбрать их нельзя.

test('тап по серому дню прошлого месяца листает сетку спорта на этот месяц', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-15T12:00:00'));
  await openApp(page, '/more/health');
  await page.getByRole('button', { name: 'Месяц', exact: true }).click();
  await expect(page.getByText('Сентябрь 2026', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /^31 августа 2026/ }).click();
  await expect(page.getByText('Август 2026', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^31 августа 2026, выбрано/ })).toHaveAttribute('aria-pressed', 'true');
});
