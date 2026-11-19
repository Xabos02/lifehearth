import { test, expect, openApp } from './fixtures';

// «Сегодня», открытая с вечера и пережившая полночь (аудит 1.64.0: H4, H15,
// NEW-H-1). Экран считал «сегодня» при отрисовке, а сам на смене суток не
// перерисовывался: совет спорта оставался вчерашним, быстрый ввод ставил
// задачу на вчера. Перерисовка на смене суток не должна сбрасывать форму
// «Отметить», открытую до полуночи.

async function seedWorkout(page: import('@playwright/test').Page, date: string) {
  await page.evaluate(async (d) => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    await db.workouts.put({
      id: `w-${d}`, createdAt: now, updatedAt: now, deletedAt: null,
      date: d, type: 'kettlebell', minutes: 30, distanceKm: null, effort: null, note: '', source: 'manual',
    });
  }, date);
}

test('после полуночи совет спорта — уже на новый день, быстрый ввод ставит задачу на новый день', async ({ page }) => {
  // Запас в час: openApp под нагрузкой идёт секунды.
  await page.clock.install({ time: new Date('2026-09-16T23:00:00') });
  await openApp(page, '/');
  await seedWorkout(page, '2026-09-15');
  const line = page.getByTestId('sport-today');
  await expect(line).toContainText('Сегодня — отдых');

  // Полтора часа без касаний: экран сам переходит на 17-е, где вчера
  // тренировки не было.
  await page.clock.fastForward('01:30:00');
  await expect(line).toContainText('Сегодня — тренировка');

  await page.getByPlaceholder('Что нужно сделать?').fill('Купить хлеб');
  await page.getByPlaceholder('Что нужно сделать?').press('Enter');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts');
        return (await db.tasks.toArray()).find((t) => t.title === 'Купить хлеб')?.dueDate ?? null;
      }),
    )
    .toBe('2026-09-17');
});

test('быстрый ввод в первую минуту после полуночи — уже на новый день, ещё до перерисовки экрана', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-16T23:00:00') });
  await openApp(page, '/');
  await expect(page.getByPlaceholder('Что нужно сделать?')).toBeVisible();
  // Часы перескочили без таймеров: экран прежний, опрос смены суток ещё не
  // сработал, а запись уже должна уйти на новые сутки.
  await page.clock.setSystemTime(new Date('2026-09-17T00:00:10'));
  await page.getByPlaceholder('Что нужно сделать?').fill('Позвонить маме');
  await page.getByPlaceholder('Что нужно сделать?').press('Enter');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts');
        return (await db.tasks.toArray()).find((t) => t.title === 'Позвонить маме')?.dueDate ?? null;
      }),
    )
    .toBe('2026-09-17');
});

test('форма «Отметить», открытая до полуночи, не сбрасывается после неё и пишет на день открытия', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-16T23:00:00') });
  await openApp(page, '/');
  await seedWorkout(page, '2026-09-14');
  const line = page.getByTestId('sport-today');
  await expect(line).toContainText('Сегодня — тренировка');

  await line.getByRole('button', { name: 'Отметить' }).click();
  const sheet = page.locator('body > div.fixed.inset-0.z-50');
  await sheet.getByRole('button', { name: 'Гири', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Гири', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Полночь прошла, и экран перерисовался: сам на смене суток и от записи
  // с другого устройства.
  await page.clock.fastForward('01:30:00');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    await db.tasks.put({
      id: 't-sync', title: 'С другого устройства', createdAt: now, updatedAt: now, deletedAt: null,
      completedAt: null, dueDate: '2026-09-17', priority: 0, sortOrder: 0, projectId: null,
    } as never);
  });
  // Задача на новый день видна — экран точно перерисовался под шторкой.
  await expect(page.getByText('С другого устройства')).toBeAttached();
  await expect(sheet.getByRole('button', { name: 'Гири', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.locator('input[type="date"]')).toHaveValue('2026-09-16');

  await sheet.getByRole('button', { name: 'Сохранить' }).click();
  await expect(sheet).toHaveCount(0);
  const stored = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.workouts.toArray()).filter((w) => w.type === 'kettlebell' && w.id !== 'w-2026-09-14').map((w) => w.date);
  });
  expect(stored).toEqual(['2026-09-16']);
});
