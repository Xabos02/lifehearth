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

test('мелодии конца фокуса и конца перерыва — разные, выбираются в шите и переживают перезагрузку', async ({ page }) => {
  await openApp(page, '/more/focus');
  await page.getByRole('button', { name: /Конец фокуса/ }).click();
  await page.getByRole('radio', { name: 'Гонг' }).click();
  await expect(page.getByRole('radio', { name: 'Гонг' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('button', { name: /Конец перерыва/ }).click();
  await page.getByRole('radio', { name: 'Фанфары' }).click();
  await page.getByRole('button', { name: 'Закрыть' }).click();

  await page.reload();
  await expect(page.getByRole('button', { name: /Конец фокуса/ })).toContainText('Гонг');
  await expect(page.getByRole('button', { name: /Конец перерыва/ })).toContainText('Фанфары');
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), KEY);
  expect(stored.alarmWork).toBe('gong');
  expect(stored.alarmBreak).toBe('fanfare');
});

test('старый единый сигнал становится сигналом конца фокуса', async ({ page }) => {
  await openApp(page, '/more/focus');
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ alarm: 'bell', workMin: 25 })), KEY);
  await page.reload();
  await expect(page.getByRole('button', { name: /Конец фокуса/ })).toContainText('Колокольчик');
});

test('громкость, шум и «предупредить за 5 минут» сохраняются', async ({ page }) => {
  await openApp(page, '/more/focus');
  await page.getByRole('button', { name: /Фоновый шум/ }).click();
  await page.getByRole('radio', { name: 'Костёр' }).click();
  await page.getByLabel('Громкость шума').fill('30');
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('switch', { name: /Предупредить за 5 минут/ }).click();

  await page.reload();
  await expect(page.getByRole('button', { name: /Фоновый шум/ })).toContainText('Костёр');
  await expect(page.getByRole('switch', { name: /Предупредить за 5 минут/ })).toHaveAttribute('aria-checked', 'true');
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), KEY);
  expect(stored.sound).toBe('fire');
  expect(stored.noiseVolume).toBeCloseTo(0.3, 5);
  expect(stored.preNotify).toBe(true);
});

test('режим на весь экран: время идёт, кнопки работают, сворачивается', async ({ page }) => {
  await openApp(page, '/more/focus');
  await page.getByRole('button', { name: 'На весь экран' }).click();
  const fs = page.getByTestId('focus-fullscreen');
  await expect(fs).toBeVisible();
  await expect(fs).toContainText('Круг 1 из 4');
  await fs.getByRole('button', { name: 'Старт' }).click();
  const clock = page.getByTestId('fullscreen-clock');
  const first = await clock.innerText();
  await page.waitForTimeout(1600);
  expect(await clock.innerText()).not.toBe(first);
  await fs.getByRole('button', { name: 'Свернуть' }).click();
  await expect(fs).toHaveCount(0);
  // Таймер продолжает идти на обычном экране.
  await expect(page.getByRole('button', { name: 'Пауза' })).toBeVisible();
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
