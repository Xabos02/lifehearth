import { test, expect, openApp } from './fixtures';

// Задача 38: упражнения с подходами внутри вида, минуты и км по желанию,
// барабан дат со щелчком на каждом дне (канва design/sport-exercises, А/А).

test('шаблон из упражнений без минут: сохраняется, грузится в тренировку, в списке без «0 мин»', async ({ page }) => {
  await openApp(page, '/more/health');
  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  await page.getByRole('button', { name: 'Из шаблона' }).click();
  await page.getByRole('button', { name: 'Новый шаблон' }).click();
  await page.getByPlaceholder('Например, «День ног»').fill('Утро');
  // Шаблон стартует с силовой и пустыми минутами — сохранять можно сразу.
  await page.getByRole('button', { name: 'Упражнение' }).last().click();
  await page.getByLabel('Название упражнения').last().fill('Отжимания');
  await page.getByLabel('Подходов').last().fill('3');
  await page.getByLabel('Повторов').last().fill('15');
  // Пустая строка упражнения не сохраняется — это недописанная строка.
  await page.getByRole('button', { name: 'Упражнение' }).last().click();
  await page.getByRole('button', { name: 'Сохранить шаблон' }).click();

  const tpl = page.getByRole('button', { name: /^Утро/ });
  await expect(tpl).toContainText('Силовая');
  await expect(tpl).not.toContainText('мин');
  const stored = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.workoutTemplates.toArray())[0].items;
  });
  expect(stored).toEqual([
    {
      type: 'strength', customLabel: null, customColor: null, minutes: 0, distanceKm: null,
      exercises: [{ name: 'Отжимания', sets: 3, reps: 15 }],
    },
  ]);

  await tpl.click();
  await expect(page.getByLabel('Название упражнения')).toHaveValue('Отжимания');
  // Сегодня сделал на подход больше — правка в тренировке, не в шаблоне.
  await page.getByLabel('Подходов').fill('4');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();

  const row = page.getByRole('button', { name: /^Силовая/ }).first();
  await expect(row).toContainText('Отжимания 4×15');
  await expect(row).not.toContainText('мин');
  // «За 30 дней по видам»: вид без времени — числом занятий, а не «0 мин».
  await expect(page.getByText('1 раз', { exact: true })).toBeVisible();

  // Следующая силовая подсказывает упражнение с прошлого раза.
  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  await page.getByRole('button', { name: 'Силовая', exact: true }).click();
  await page.getByRole('button', { name: '+ Отжимания' }).click();
  // 4, а не 3 из шаблона: подсказка берёт подходы с последней тренировки.
  await expect(page.getByLabel('Подходов')).toHaveValue('4');
  await expect(page.getByLabel('Повторов')).toHaveValue('15');
});

test('барабан дат: щелчок на каждом пройденном дне, выбор — когда лента встала', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-16T12:00:00'));
  // Подменный AudioContext считает щелчки: живой звук в headless не услышать.
  await page.addInitScript(() => {
    const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
    const node = () => ({ connect() {}, start() {}, stop() {}, buffer: null, type: '', frequency: param(), Q: param(), gain: param() });
    class FakeAudio {
      state = 'running';
      sampleRate = 44100;
      destination = {};
      get currentTime() { return performance.now() / 1000; }
      resume() { return Promise.resolve(); }
      createBuffer(_c: number, len: number) { return { getChannelData: () => new Float32Array(len) }; }
      createBufferSource() { (window as unknown as { __ticks: number }).__ticks++; return node(); }
      createBiquadFilter() { return node(); }
      createGain() { return node(); }
      createOscillator() { return node(); }
    }
    (window as unknown as { __ticks: number }).__ticks = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudio;
  });
  await openApp(page, '/more/health');
  const wheel = page.getByTestId('workout-week');
  await expect(wheel.locator('button').last()).toHaveAttribute('aria-pressed', 'true');

  // Три шага назад по одному дню — три щелчка.
  for (let i = 0; i < 3; i++) {
    await wheel.evaluate((el) => {
      el.scrollLeft -= 48;
    });
    await page.waitForTimeout(60);
  }
  expect(await page.evaluate(() => (window as unknown as { __ticks: number }).__ticks)).toBe(3);
  await expect(page.getByTestId('wheel-caption')).toContainText('Воскресенье, 13 сентября');
  // Выбор доезжает до списка дня после остановки ленты.
  await expect(page.getByRole('heading', { name: '13 сентября, воскресенье' })).toBeVisible();

  // Клавиатура: в порядке фокуса один выбранный день, стрелка листает на день.
  await expect(wheel.locator('button[tabindex="0"]')).toHaveCount(1);
  await wheel.locator('button[aria-pressed="true"]').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('heading', { name: '12 сентября, суббота' })).toBeVisible();
});
