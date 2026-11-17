import { test, expect, openApp } from './fixtures';
import type { Page } from '@playwright/test';

// Отклик на касания (PROTOCOL §6.4, канва design/tap-feedback, выбран А).
// Щелчок iPhone браузер не воспроизводит — проверяем то, от чего он зависит:
// тап попадает в спрятанный системный переключатель (тот переключается),
// Android получает vibrate, а выключатель «Отклик на касания» гасит всё разом —
// накладки, вибрацию и щелчок барабана. Кнопки «Скопировать» — haptic.spec.ts.

// Подменные vibrate и AudioContext: живой звук и мотор в headless не услышать,
// а считать вызовы можно. AudioContext — как в sport-exercises.spec.ts.
async function stubFeedback(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __vib: unknown[]; __ticks: number; __sw: number; AudioContext: unknown };
    w.__vib = [];
    w.__ticks = 0;
    w.__sw = 0;
    navigator.vibrate = (p: VibratePattern) => (w.__vib.push(p), true);
    // Переключения спрятанных переключателей накладок — по всему документу:
    // строка, где был тап, может уже уехать (выполненная задача уходит в
    // «Выполненные»), а щелчок iPhone случился в момент переключения.
    document.addEventListener('change', (e) => {
      if ((e.target as Element).matches?.('[data-haptic] input[switch]')) w.__sw++;
    }, true);
    const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
    const node = () => ({ connect() {}, start() {}, stop() {}, buffer: null, type: '', frequency: param(), Q: param(), gain: param() });
    class FakeAudio {
      state = 'running';
      sampleRate = 44100;
      destination = {};
      get currentTime() { return performance.now() / 1000; }
      resume() { return Promise.resolve(); }
      createBuffer(_c: number, len: number) { return { getChannelData: () => new Float32Array(len) }; }
      createBufferSource() { w.__ticks++; return node(); }
      createBiquadFilter() { return node(); }
      createGain() { return node(); }
      createOscillator() { return node(); }
    }
    w.AudioContext = FakeAudio;
  });
}

const vib = (page: Page) => page.evaluate(() => (window as unknown as { __vib: unknown[] }).__vib);
const ticks = (page: Page) => page.evaluate(() => (window as unknown as { __ticks: number }).__ticks);
const switches = (page: Page) => page.evaluate(() => (window as unknown as { __sw: number }).__sw);

test('сегмент и переключатель щёлкают, выбранный сегмент молчит; «Отклик на касания» гасит всё, барабан тоже', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-16T12:00:00'));
  await stubFeedback(page);
  await openApp(page, '/more/settings');

  const fb = page.getByRole('switch', { name: 'Отклик на касания' });
  await expect(fb).toHaveAttribute('aria-checked', 'true');
  await expect(fb.locator('input[type="checkbox"]')).toHaveAttribute('switch', '');

  // Смена темы: переключатель сегмента щёлкает, вибрация одна.
  const light = page.getByRole('button', { name: 'Светлая', exact: true });
  const lightSw = light.locator('input[type="checkbox"]');
  await expect(lightSw).not.toBeChecked();
  await light.click();
  await expect(light).toHaveAttribute('aria-pressed', 'true');
  await expect(lightSw).toBeChecked();
  expect(await vib(page)).toEqual([10]);

  // Тап по уже выбранному ничего не меняет — и не щёлкает: накладка
  // пропускает касание, переключатель стоит, вибрации нет.
  await light.click();
  await expect(lightSw).toBeChecked();
  expect(await vib(page)).toEqual([10]);

  // Выключение: сам выключатель щёлкает последний раз, дальше накладок нет.
  await fb.click();
  await expect(fb).toHaveAttribute('aria-checked', 'false');
  expect(await vib(page)).toEqual([10, 10]);
  await expect(page.locator('[data-haptic]')).toHaveCount(0);
  expect(
    await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      return (await db.settings.get('app'))?.tapFeedback;
    }),
  ).toBe(false);

  await page.getByRole('button', { name: 'Тёмная', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Тёмная', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await vib(page)).toEqual([10, 10]);

  // Барабан дат в «Спорте» молчит: три дня прокрутки — ни одного щелчка
  // (при включённом их три — sport-exercises.spec.ts).
  await page.goto('/more/health');
  const wheel = page.getByTestId('workout-week');
  await expect(wheel.locator('button').last()).toHaveAttribute('aria-pressed', 'true');
  for (let i = 0; i < 3; i++) {
    await wheel.evaluate((el) => {
      el.scrollLeft -= 48;
    });
    await page.waitForTimeout(60);
  }
  // Лента правда уехала на три дня — иначе ноль щелчков ничего не доказывает.
  await expect(page.getByTestId('wheel-caption')).toContainText('Воскресенье, 13 сентября');
  expect(await ticks(page)).toBe(0);
  await expect(page.locator('[data-haptic]')).toHaveCount(0);
});

test('отметка задачи щёлкает: переключатель под пальцем, выполнение одно, вибрация одна', async ({ page }) => {
  await stubFeedback(page);
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
  const check = page.locator('[data-task-id="t1"]').getByRole('button', { name: 'Выполнить' });
  await expect(check.locator('input[type="checkbox"]')).toHaveAttribute('switch', '');
  await check.click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts');
        return Boolean((await db.tasks.get('t1'))?.completedAt);
      }),
    )
    .toBe(true);
  // Выполненная уехала в «Выполненные», но переключатель успел щёлкнуть — один раз.
  expect(await switches(page)).toBe(1);
  expect(await vib(page)).toEqual([10]);
  // Шторка задачи не открылась: клик переключателя дальше label не идёт.
  await expect(page.getByRole('heading', { name: 'Задача' })).toHaveCount(0);
});

test('у выбранного чипа накладка молчит, а зона касания 44 остаётся', async ({ page }) => {
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
  // «Убрать» без срока ничего не меняет — накладка выключена.
  const clear = page.getByRole('button', { name: 'Убрать', exact: true });
  await expect(clear.locator('[data-haptic]')).toHaveAttribute('data-haptic', 'off');
  await clear.scrollIntoViewIfNeeded();
  const box = (await clear.boundingBox())!;
  expect(box.height).toBeLessThan(40);
  // Тап на 3px ниже чипа — в невидимой зоне 44: попадает в саму кнопку.
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent ?? null,
    { x: box.x + box.width / 2, y: box.y + box.height + 3 },
  );
  expect(hit).toBe('Убрать');
});

test('«Спорт»: выбранный вид и единица молчат, смена вида и шаг цели щёлкают', async ({ page }) => {
  await stubFeedback(page);
  await openApp(page, '/more/health');

  // Шаг цели на неделю — щелчок и вибрация.
  await page.getByRole('button', { name: 'Цель: больше' }).click();
  await expect(page.getByTestId('weekly-goal')).toHaveText('4');
  expect(await switches(page)).toBe(1);
  expect(await vib(page)).toEqual([10]);

  // Новая тренировка — бег по умолчанию. Тап по уже выбранному виду ничего не
  // меняет и не щёлкает: раньше переключатель срабатывал и здесь.
  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  const run = page.getByRole('button', { name: 'Бег', exact: true });
  await expect(run).toHaveAttribute('aria-pressed', 'true');
  await run.click();
  expect(await switches(page)).toBe(1);

  // Смена вида щёлкает один раз, повторный тап по нему — снова тишина.
  const strength = page.getByRole('button', { name: 'Силовая', exact: true });
  await strength.click();
  await expect(strength).toHaveAttribute('aria-pressed', 'true');
  expect(await switches(page)).toBe(2);
  await strength.click();
  expect(await switches(page)).toBe(2);

  // Единица упражнения — тот же выбор одного варианта. Она под «Подробнее»;
  // раскрытие — не выбор и молчит, как раскрытие вида (PROTOCOL §6.4).
  await page.getByRole('button', { name: 'Упражнение', exact: true }).click();
  await page.getByRole('button', { name: /^Подробнее/ }).click();
  expect(await switches(page)).toBe(2);
  const reps = page.getByRole('button', { name: 'повторы', exact: true });
  await expect(reps).toHaveAttribute('aria-pressed', 'true');
  await reps.click();
  expect(await switches(page)).toBe(2);
  await page.getByRole('button', { name: 'сек', exact: true }).click();
  await expect(page.getByRole('button', { name: 'сек', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await switches(page)).toBe(3);
  expect(await vib(page)).toEqual([10, 10, 10]);
});
