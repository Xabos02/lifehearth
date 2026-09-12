import { test, expect, openApp } from './fixtures';

// Задача 6 «Фокус»: выбор сигнала, число кругов до длинного перерыва, точки
// цикла под таймером и молчаливая докрутка после фона.

const KEY = 'life-hub-pomodoro';

/** Подменить сохранённое состояние таймера и перезайти на экран. */
async function seedTimer(page: import('@playwright/test').Page, patch: Record<string, unknown>) {
  await page.evaluate(
    ([key, p]) => {
      const cur = JSON.parse(localStorage.getItem(key as string) ?? '{}');
      localStorage.setItem(key as string, JSON.stringify({ ...cur, ...(p as object) }));
    },
    [KEY, patch] as const,
  );
  await page.goto('/more/focus');
  await expect(page.getByRole('heading', { name: 'Фокус' })).toBeVisible();
}

test('сигнал конца круга выбирается и переживает перезагрузку', async ({ page }) => {
  await openApp(page, '/more/focus');
  const gong = page.getByRole('button', { name: 'Гонг' });
  await expect(gong).toHaveAttribute('aria-pressed', 'false');
  await gong.click();
  await expect(gong).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Гонг' })).toHaveAttribute('aria-pressed', 'true');
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), KEY);
  expect(stored.alarm).toBe('gong');
});

test('число кругов до длинного перерыва — своё, и точки под таймером его показывают', async ({ page }) => {
  await openApp(page, '/more/focus');
  const dots = page.getByTestId('cycle-dots');
  await expect(dots.locator('span')).toHaveCount(4);

  await page.getByRole('button', { name: 'Кругов до него: меньше' }).click();
  await page.getByRole('button', { name: 'Кругов до него: меньше' }).click();
  await expect(dots.locator('span')).toHaveCount(2);
  await expect(dots).toHaveAttribute('aria-label', 'Круг 1 из 2');

  // Второй круг при «2 до длинного» ведёт в длинный перерыв, а не в короткий.
  await seedTimer(page, {
    phase: 'work',
    running: true,
    workCount: 1,
    longAfter: 2,
    endsAt: Date.now() + 700,
  });
  await expect(page.getByText('Длинный перерыв', { exact: true }).first()).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('cycle-dots')).toHaveAttribute('data-done', '2');
});

test('круг, кончившийся давно в фоне, засчитан молча, а не «завершён» с этой секунды', async ({ page }) => {
  await openApp(page, '/more/focus');
  const MIN = 60_000;
  // Рабочий круг кончился час назад, перерыв после него — тоже.
  await seedTimer(page, {
    phase: 'work',
    running: true,
    workCount: 0,
    workMin: 25,
    breakMin: 5,
    completedToday: 0,
    focusMinToday: 0,
    date: new Date().toISOString().slice(0, 10),
    endsAt: Date.now() - 60 * MIN,
  });
  // Таймер ждёт в начале следующего круга, круг засчитан.
  await expect(page.getByRole('button', { name: 'Старт' })).toBeVisible();
  await expect(page.locator('p.text-2xl.font-bold').first()).toHaveText('1');
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), KEY);
  expect(stored.phase).toBe('work');
  expect(stored.running).toBe(false);
  expect(stored.focusMinToday).toBe(25);

  // А если перерыв ещё идёт — таймер на его настоящем остатке, не на полных пяти.
  await seedTimer(page, {
    phase: 'work',
    running: true,
    workCount: 1,
    completedToday: 1,
    endsAt: Date.now() - 2 * MIN,
  });
  await expect(page.getByText('Перерыв', { exact: true }).first()).toBeVisible();
  const clock = await page.locator('span.text-5xl').innerText();
  expect(clock.startsWith('02:5') || clock.startsWith('03:0')).toBe(true);
});

test('в простое «Завершить круг» неактивна, а тап по цифрам не меняет длительность', async ({ page }) => {
  await openApp(page, '/more/focus');
  await expect(page.getByRole('button', { name: 'Завершить круг' })).toBeDisabled();

  // Тап по центру кольца (по цифрам) — длительность прежняя.
  const before = await page.locator('span.text-5xl').innerText();
  const svg = page.locator('svg[viewBox="0 0 300 300"]');
  const box = (await svg.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2 + 10, box.y + box.height / 2 + 10);
  await expect(page.locator('span.text-5xl')).toHaveText(before);

  // А по дорожке кольца — меняет: верхняя точка кольца = минимум шага.
  await page.mouse.click(box.x + box.width / 2, box.y + (box.height * 20) / 300);
  await expect(page.locator('span.text-5xl')).not.toHaveText(before);
});

test('на паузе кольцо показывает прогресс, а не превращается в слайдер', async ({ page }) => {
  await openApp(page, '/more/focus');
  await page.getByRole('button', { name: 'Старт' }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Пауза' }).click();
  const paused = await page.locator('span.text-5xl').innerText();
  expect(paused).not.toBe('25:00');
  await expect(page.getByText('крутите кольцо ↻')).toHaveCount(0);

  // Касание кольца на паузе ничего не сбрасывает.
  const svg = page.locator('svg[viewBox="0 0 300 300"]');
  const box = (await svg.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + (box.height * 20) / 300);
  await expect(page.locator('span.text-5xl')).toHaveText(paused);
});
