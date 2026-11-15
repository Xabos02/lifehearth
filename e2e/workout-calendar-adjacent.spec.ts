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

test('«Месяц», пока барабан доезжает: сетка открывается на месяце дня под полосой', async ({ page }) => {
  // День под полосой выбирается, когда барабан уходит с экрана, — уже после
  // того, как сетка встала на прежний выбранный день: открывался «Сентябрь»
  // без выделенной клетки, а список под ним был про 29 августа.
  await page.clock.setFixedTime(new Date('2026-09-03T12:00:00'));
  await openApp(page, '/more/health');
  const wheel = page.getByTestId('workout-week');
  await expect(wheel.locator('button').last()).toHaveAttribute('aria-pressed', 'true');
  // «Месяц» — по первому же событию прокрутки, до остановки ленты (120 мс).
  await wheel.evaluate(async (el) => {
    const scrolled = new Promise((r) => el.addEventListener('scroll', r, { once: true }));
    el.scrollLeft -= 5 * 48;
    await scrolled;
    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Месяц')?.click();
  });
  await expect(page.getByText('Август 2026', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^29 августа 2026, выбрано/ })).toHaveAttribute('aria-pressed', 'true');
});

// Скептик починки календаря (15.11.2026): две мелкие потери от самой починки.

test('«Сегодня», нажатая сразу после тапа по дню, не теряется', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-16T12:00:00'));
  await openApp(page, '/more/health');
  const wheel = page.getByTestId('workout-week');
  await expect(wheel.locator('button').last()).toHaveAttribute('aria-pressed', 'true');
  // Тап по дню за три дня до сегодня и «Сегодня» через кадр — лента ещё не
  // прошла и полшага: под полосой по-прежнему сегодняшний день.
  await wheel.evaluate(async (el) => {
    const days = el.querySelectorAll('button');
    days[days.length - 4].click();
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Сегодня')!.click();
  });
  await page.waitForTimeout(900);
  await expect(page.getByTestId('wheel-caption')).toContainText('сегодня');
  await expect(wheel.locator('button').last()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Сегодня', exact: true })).toBeVisible();
});

test('тап по уже выбранному серому дню соседнего месяца листает сетку на его месяц', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-15T12:00:00'));
  await openApp(page, '/more/health');
  await page.getByRole('button', { name: 'Месяц', exact: true }).click();
  await page.getByRole('button', { name: /^1 ноября 2026/ }).click();
  await page.getByRole('button', { name: 'Предыдущий месяц' }).click();
  await expect(page.getByText('Октябрь 2026', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^1 ноября 2026, выбрано/ }).click();
  await expect(page.getByText('Ноябрь 2026', { exact: true })).toBeVisible();
});

