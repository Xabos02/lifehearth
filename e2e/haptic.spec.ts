import { test, expect, openApp } from './fixtures';

// Тактильный отклик кнопки «Скопировать» (components/ui/Haptic.tsx).
// Вибрацию iPhone браузер не воспроизводит — проверяем то, от чего она
// зависит: тап попадает в label спрятанного переключателя (тот
// переключается), обработчик кнопки срабатывает ровно один раз, а Android
// получает vibrate. Тап у края зоны 44×44 — тоже по label: иначе его
// перехватывает ::after из HIT_SLOP_44, и iPhone молчит (index.css).

test('«Скопировать название»: переключатель щёлкает, копия одна, вибрация одна — и у края зоны касания', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __vib: unknown[]; __clip: string[] };
    w.__vib = [];
    w.__clip = [];
    navigator.vibrate = (p: VibratePattern) => (w.__vib.push(p), true);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (s: string) => void w.__clip.push(s) },
    });
  });
  await openApp(page, '/tasks', { seenHints: ['tasks-quick-add', 'tasks-gestures'] });
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    await db.tasks.put({
      id: 't1', createdAt: now, updatedAt: now, deletedAt: null,
      title: 'Купить хлеб', notes: '', projectId: null, goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: 1000,
    } as never);
  });
  await page.locator('[data-task-id="t1"]').click();
  await expect(page.getByRole('heading', { name: 'Задача' })).toBeVisible();

  const copy = page.getByRole('button', { name: 'Скопировать название' });
  const sw = copy.locator('input[type="checkbox"]');
  await expect(sw).toHaveAttribute('switch', '');
  await expect(sw).not.toBeChecked();

  await copy.click();
  await expect(page.getByRole('status')).toHaveText('Скопировано');
  await expect(sw).toBeChecked();
  const after1 = await page.evaluate(() => {
    const w = window as unknown as { __vib: unknown[]; __clip: string[] };
    return { __vib: w.__vib, __clip: w.__clip };
  });
  expect(after1.__clip).toEqual(['Купить хлеб']);
  expect(after1.__vib).toEqual([10]);

  // Край невидимой зоны: кнопка меньше 44px, тап на 20px левее её центра.
  const box = (await copy.boundingBox())!;
  expect(box.width).toBeLessThan(40);
  await page.mouse.click(box.x + box.width / 2 - 20, box.y + box.height / 2);
  await expect(sw).not.toBeChecked();
  const after2 = await page.evaluate(() => {
    const w = window as unknown as { __vib: unknown[]; __clip: string[] };
    return { __vib: w.__vib, __clip: w.__clip };
  });
  expect(after2.__clip).toHaveLength(2);
  expect(after2.__vib).toEqual([10, 10]);

  // Зона копирования выступает вниз на поле «Название», но поле стоит позже
  // и перекрытие выигрывает оно — как выигрывало у ::after: тап по верхнему
  // краю ставит курсор, а не копирует.
  const field = page.locator('textarea[placeholder="Что нужно сделать?"]');
  const fb = (await field.boundingBox())!;
  expect(fb.y).toBeLessThan(box.y + box.height / 2 + 22);
  await page.mouse.click(box.x + box.width / 2, fb.y + 2); // прямо под кнопкой
  await expect(field).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { __clip: string[] }).__clip.length)).toBe(2);

  // Пустое название — копировать нечего, щелчка нет.
  await field.fill('');
  await expect(sw).toHaveCount(0);
});
