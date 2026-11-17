import { test, expect, openApp, answerConfirm } from './fixtures';
import type { Locator, Page } from '@playwright/test';

// Шаблоны тренировок: добавление и правка (15.11.2026, канва
// design/sport-templates — вариант Б, чипы в карточке дня, барабан времени).
// Программа владельца — диапазон «6–8», секунды и минуты, вес, отдых,
// пометки — должна ложиться в шаблон целиком и возвращаться без потерь.

const SHEET = 'body > div.fixed.inset-0.z-50';

const item = (type: string, minutes: number, distanceKm: number | null, exercises: object[]) => ({
  type,
  customLabel: null,
  customColor: null,
  minutes,
  distanceKm,
  exercises,
});

const TEMPLATE_A = {
  name: 'Тренировка А',
  totalMinutes: 70,
  note: 'Запас 1–2 повтора до отказа',
  items: [
    item('run', 12, 2, [{ name: 'Дорожка', sets: null, reps: null, note: '10,5–11,5 км/ч, уклон 1,5–2%' }]),
    item('strength', 45, null, [
      { name: 'Подтягивания с поясом', sets: 4, reps: 6, repsTo: 8, weight: '+10–15 кг', rest: '2 мин', note: 'Разминка 1×5–6' },
      { name: 'Брусья с поясом', sets: 4, reps: 8, repsTo: 10, weight: '+15–20 кг', rest: '2 мин' },
      { name: 'Изометрия на шею', sets: 2, reps: 12, repsTo: 15, unit: 'sec', rest: '30 сек' },
    ]),
    item('boxing', 11, null, [{ name: 'Раунд 1', sets: null, reps: 3, unit: 'min', rest: '1 мин', note: 'Джеб с шагом, сайд-степ' }]),
  ],
};

async function seedTemplate(page: Page, tpl: object) {
  await page.evaluate(async (draft) => {
    const { addTemplate } = await import('/src/features/health/templateRepo.ts');
    await addTemplate(draft as never);
  }, tpl);
}

const templates = (page: Page) =>
  page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return db.workoutTemplates.toArray();
  });

const workouts = (page: Page) =>
  page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.workouts.toArray()).filter((w) => !w.deletedAt);
  });

/** Подменный AudioContext считает щелчки: живой звук в headless не услышать. */
async function countTicks(page: Page) {
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
}
const ticks = (page: Page) => page.evaluate(() => (window as unknown as { __ticks: number }).__ticks);

async function openTemplates(page: Page) {
  await page.getByTestId('day-templates').getByRole('button', { name: 'Шаблоны', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Шаблоны тренировок' })).toBeVisible();
}

test('шаблон с нуля: диапазон, секунды, вес, отдых, пометка, общее время и памятка — в базе без лишних ключей', async ({ page }) => {
  await openApp(page, '/more/health');
  // Шаблонов нет — в карточке дня только ссылка на список.
  await expect(page.getByTestId('day-templates')).toContainText('Шаблонов пока нет');
  await openTemplates(page);
  await expect(page.locator(SHEET).getByText('Шаблонов пока нет.')).toBeVisible();
  await page.getByRole('button', { name: 'Новый шаблон' }).click();
  const save = page.getByRole('button', { name: 'Сохранить шаблон' });
  await expect(save).toBeDisabled();
  await page.getByLabel('Название шаблона').fill('  Тренировка А  ');
  await page.getByLabel('Памятка').fill('Запас 1–2 повтора до отказа');

  const add = page.getByRole('button', { name: 'Упражнение', exact: true });
  const editor = page.getByTestId('exercise-editor');
  await add.click();
  // Без названия строка не упражнение: свернуть её нельзя.
  await expect(page.getByRole('button', { name: 'Готово' })).toBeDisabled();
  await expect(page.getByLabel('Название упражнения')).toBeFocused();
  await page.getByLabel('Название упражнения').fill('Подтягивания с поясом');
  await page.getByLabel('Подходы').fill('4');
  // Границы перепутаны — в строке и в базе встают по порядку.
  await page.getByLabel('Повторы', { exact: true }).fill('8');
  await page.getByLabel('Повторы, до').fill('6');
  // Вес, отдых, заметка и единицы — по «Подробнее»: сначала главное.
  await expect(page.getByLabel('Вес')).toHaveCount(0);
  await page.getByRole('button', { name: /^Подробнее/ }).click();
  await page.getByLabel('Вес').fill('+10–15 кг');
  await page.getByLabel('Отдых').fill('2 мин');
  await editor.getByLabel('Заметка').fill('Разминка 1×5–6 со своим весом');

  // Следующее упражнение сворачивает дописанное в строку — открыта одна.
  await add.click();
  await expect(editor).toHaveCount(1);
  const rows = page.getByTestId('exercise-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Подтягивания с поясом');
  await expect(rows.first()).toContainText('4 × 6–8');
  await expect(rows.first()).toContainText('+10–15 кг · отдых 2 мин');
  await expect(rows.first()).toContainText('Разминка 1×5–6 со своим весом');

  await page.getByLabel('Название упражнения').fill('Изометрия на шею');
  await page.getByLabel('Подходы').fill('2');
  await page.getByLabel('Повторы', { exact: true }).fill('12');
  await page.getByLabel('Повторы, до').fill('15');
  await page.getByRole('button', { name: /^Подробнее/ }).click();
  await page.getByRole('button', { name: 'сек', exact: true }).click();
  await expect(editor.getByText('Секунды')).toBeVisible();
  await page.getByLabel('Отдых').fill('30 сек');
  await page.getByRole('button', { name: 'Готово' }).click();
  await expect(rows.nth(1)).toContainText('2 × 12–15 сек');

  // Раунд на мешке: одни минуты, без подходов.
  await add.click();
  await page.getByLabel('Название упражнения').fill('Раунд 1');
  await page.getByLabel('Повторы', { exact: true }).fill('3');
  await page.getByRole('button', { name: /^Подробнее/ }).click();
  await page.getByRole('button', { name: 'мин', exact: true }).click();
  await page.getByRole('button', { name: 'Готово' }).click();
  await expect(rows.nth(2)).toContainText('3 мин');

  await save.click();
  const row = page.getByRole('button', { name: /^Тренировка А/ });
  await expect(row).toContainText('Силовая');
  const stored = await templates(page);
  expect(stored).toHaveLength(1);
  expect(stored[0].name).toBe('Тренировка А');
  expect(stored[0].note).toBe('Запас 1–2 повтора до отказа');
  expect('totalMinutes' in stored[0]).toBe(false);
  // toStrictEqual: пустые вес, отдых, пометка и единица в запись не попадают.
  expect(stored[0].items).toStrictEqual([
    {
      type: 'strength', customLabel: null, customColor: null, minutes: 0, distanceKm: null,
      exercises: [
        { name: 'Подтягивания с поясом', sets: 4, reps: 6, repsTo: 8, weight: '+10–15 кг', rest: '2 мин', note: 'Разминка 1×5–6 со своим весом' },
        { name: 'Изометрия на шею', sets: 2, reps: 12, repsTo: 15, unit: 'sec', rest: '30 сек' },
        { name: 'Раунд 1', sets: null, reps: 3, unit: 'min' },
      ],
    },
  ]);

  // Перезагрузка: шаблон на месте, в карточке дня — чипом.
  await page.reload();
  await expect(page.getByRole('button', { name: 'По шаблону: Тренировка А' })).toBeVisible();
});

test('правка шаблона: название, вес, порядок, удаление упражнения и вида, минуты вида', async ({ page }) => {
  await openApp(page, '/more/health');
  await seedTemplate(page, TEMPLATE_A);
  const before = (await templates(page))[0];
  await openTemplates(page);
  await expect(page.getByRole('button', { name: /^Тренировка А/ })).toContainText('Бег, Силовая, Бокс · 1 ч 10 мин');
  await page.getByRole('button', { name: 'Изменить шаблон «Тренировка А»' }).click();
  await expect(page.getByRole('heading', { name: 'Шаблон', exact: true })).toBeVisible();
  await expect(page.getByLabel('Название шаблона')).toHaveValue('Тренировка А');
  await expect(page.getByLabel('Памятка')).toHaveValue('Запас 1–2 повтора до отказа');
  await expect(page.getByRole('button', { name: 'Общее время: 1 ч 10 мин' })).toBeVisible();

  // Сохранённый шаблон читается как программа: виды — заголовками, чипов нет.
  const kinds = page.getByTestId('workout-kind');
  await expect(kinds).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Вид: Бег, 12 мин · 2 км' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Гири', exact: true })).toHaveCount(0);
  const rows = page.getByTestId('exercise-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(1)).toContainText('Подтягивания с поясом');
  await expect(rows.nth(4)).toContainText('Джеб с шагом, сайд-степ');

  await page.getByLabel('Название шаблона').fill('Тренировка А, недели 5–8');
  // Вес на следующую ступень и упражнение — на строку ниже.
  await rows.nth(1).click();
  await page.getByLabel('Вес').fill('+12,5–17,5 кг');
  await expect(page.getByRole('button', { name: 'Поднять упражнение' })).toBeDisabled();
  await page.getByRole('button', { name: 'Опустить упражнение' }).click();
  await page.getByRole('button', { name: 'Готово' }).click();
  await expect(rows.nth(1)).toContainText('Брусья с поясом');
  await expect(rows.nth(2)).toContainText('+12,5–17,5 кг');
  // Изометрию убираем, мешок — тоже, бегу ставим 15 минут.
  await rows.nth(3).click();
  await expect(page.getByRole('button', { name: 'Опустить упражнение' })).toBeDisabled();
  await page.getByRole('button', { name: 'Убрать упражнение' }).click();
  await kinds.nth(2).getByRole('button', { name: 'Убрать', exact: true }).click();
  await expect(kinds).toHaveCount(2);
  await page.getByRole('button', { name: 'Вид: Бег, 12 мин · 2 км' }).click();
  // По плейсхолдеру, а не по подписи: у заполненного поля подпись «Минут»
  // достаётся крестику очистки, он стоит в label первым.
  await page.getByPlaceholder('по желанию', { exact: true }).first().fill('15');
  await page.getByRole('button', { name: /^Вид: Бег/ }).click();
  await expect(page.getByRole('button', { name: 'Вид: Бег, 15 мин · 2 км' })).toBeVisible();

  // При правке кнопка короче — «Сохранить»: рядом стоит «Удалить».
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Тренировка А, недели 5–8/ })).toContainText('Бег, Силовая · 1 ч 10 мин');
  const after = await templates(page);
  // Правка, а не новый шаблон: та же запись.
  expect(after).toHaveLength(1);
  expect(after[0].id).toBe(before.id);
  expect(after[0].createdAt).toBe(before.createdAt);
  expect(after[0].totalMinutes).toBe(70);
  expect(after[0].items).toStrictEqual([
    item('run', 15, 2, [{ name: 'Дорожка', sets: null, reps: null, note: '10,5–11,5 км/ч, уклон 1,5–2%' }]),
    item('strength', 45, null, [
      { name: 'Брусья с поясом', sets: 4, reps: 8, repsTo: 10, weight: '+15–20 кг', rest: '2 мин' },
      { name: 'Подтягивания с поясом', sets: 4, reps: 6, repsTo: 8, weight: '+12,5–17,5 кг', rest: '2 мин', note: 'Разминка 1×5–6' },
    ]),
  ]);
});

test('чип в карточке дня: тренировка по шаблону на выбранный день; правка в записи шаблон не меняет', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-15T12:00:00'));
  await openApp(page, '/more/health');
  await seedTemplate(page, TEMPLATE_A);
  // Вчера: барабан на день назад, чип ставит запись на выбранный день.
  const wheel = page.getByTestId('workout-week');
  await wheel.locator('button[aria-pressed="true"]').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('heading', { name: '14 ноября, суббота' })).toBeVisible();
  await page.getByRole('button', { name: 'По шаблону: Тренировка А' }).click();
  await expect(page.getByRole('heading', { name: 'Новая тренировка' })).toBeVisible();
  await expect(page.locator(SHEET).locator('input[type="date"]')).toHaveValue('2026-11-14');
  await expect(page.getByTestId('workout-kind')).toHaveCount(3);
  const rows = page.getByTestId('exercise-row');
  await expect(rows).toHaveCount(5);

  // Сегодня взял больше — правится запись, не шаблон.
  await rows.nth(1).click();
  await page.getByLabel('Вес').fill('+12,5 кг');
  await page.getByRole('button', { name: 'Готово' }).click();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator(SHEET)).toHaveCount(0);

  const day = page.locator('section', { has: page.getByRole('heading', { name: '14 ноября, суббота' }) });
  await expect(day.getByRole('button', { name: /^Силовая/ })).toContainText('Подтягивания с поясом 4×6–8, +12,5 кг');
  await expect(day.getByRole('button', { name: /^Бег/ })).toContainText('12 мин');
  await expect(day.getByRole('button', { name: /^Бокс/ })).toContainText('Раунд 1 3 мин');
  const saved = await workouts(page);
  expect(saved).toHaveLength(3);
  expect(saved.every((w) => w.date === '2026-11-14')).toBe(true);
  // Три вида — одно занятие.
  expect(new Set(saved.map((w) => w.groupId)).size).toBe(1);
  expect(saved[0].groupId).not.toBeNull();
  const strength = saved.find((w) => w.type === 'strength')!;
  expect(strength.exercises![0]).toStrictEqual({
    name: 'Подтягивания с поясом', sets: 4, reps: 6, repsTo: 8, weight: '+12,5 кг', rest: '2 мин', note: 'Разминка 1×5–6',
  });
  expect((await templates(page))[0].items[1].exercises![0].weight).toBe('+10–15 кг');
  // «Тренировок за месяц» — одна, часы — по минутам видов: 12 + 45 + 11.
  await expect(page.getByText('тренировок за месяц').locator('..')).toContainText('1');
  await expect(page.getByText('часов за месяц').locator('..')).toContainText('1,1 ч');

  // Из списка шаблонов — то же самое: выбор открывает запись.
  await openTemplates(page);
  await page.getByRole('button', { name: /^Тренировка А/ }).click();
  await expect(page.getByRole('heading', { name: 'Новая тренировка' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Шаблоны тренировок' })).toHaveCount(0);
  await expect(page.getByTestId('exercise-row')).toHaveCount(5);
});

test('закрытие редактора: без правок — молча, с правками — вопрос; удаление шаблона — обе ветки', async ({ page }) => {
  await openApp(page, '/more/health');
  await seedTemplate(page, TEMPLATE_A);
  // Подтверждения — шитом (ConfirmHost), не системным окном.
  const confirmSheet = page.getByTestId('confirm-sheet');
  const edit = async () => {
    await openTemplates(page);
    await page.getByRole('button', { name: 'Изменить шаблон «Тренировка А»' }).click();
    await expect(page.getByLabel('Название шаблона')).toHaveValue('Тренировка А');
  };
  const close = page.locator(SHEET).getByRole('button', { name: 'Закрыть' });

  // Раскрыл и свернул строку, открыл барабан — шаблон тот же: вопроса нет.
  await edit();
  await page.getByTestId('exercise-row').nth(1).click();
  await page.getByRole('button', { name: 'Готово' }).click();
  await page.getByRole('button', { name: /^Общее время/ }).click();
  await close.click();
  await expect(page.locator(SHEET)).toHaveCount(0);
  await expect(confirmSheet).toHaveCount(0);

  // С правкой: «Не сейчас» оставляет набранное, глагол закрывает без записи.
  await edit();
  await page.getByLabel('Название шаблона').fill('Другое имя');
  await close.first().click();
  expect(await answerConfirm(page, false)).toContain('Закрыть без сохранения?');
  await expect(page.getByLabel('Название шаблона')).toHaveValue('Другое имя');
  await close.first().click();
  await answerConfirm(page, true);
  await expect(page.locator(SHEET)).toHaveCount(0);
  expect((await templates(page))[0].name).toBe('Тренировка А');

  // Удаление: «Не сейчас» — шаблон на месте, «Удалить» — список пуст, запись помечена.
  await edit();
  await page.locator(SHEET).getByRole('button', { name: 'Удалить', exact: true }).click();
  const asked = await answerConfirm(page, false);
  expect(asked).toContain('Удалить шаблон «Тренировка А»?');
  expect(asked).toContain('Записанные тренировки останутся.');
  await expect(page.getByLabel('Название шаблона')).toBeVisible();
  await page.locator(SHEET).getByRole('button', { name: 'Удалить', exact: true }).click();
  await answerConfirm(page, true);
  await expect(page.locator(SHEET).getByText('Шаблонов пока нет.')).toBeVisible();
  const rows = await templates(page);
  expect(rows).toHaveLength(1);
  expect(rows[0].deletedAt).not.toBeNull();
  await close.click();
  await expect(page.getByTestId('day-templates')).toContainText('Шаблонов пока нет');
  await expect(page.getByRole('button', { name: 'По шаблону: Тренировка А' })).toHaveCount(0);
});

test('барабан общего времени: щелчок на каждом делении, клавиатура, ноль — не задано', async ({ page }) => {
  await countTicks(page);
  await openApp(page, '/more/health');
  await openTemplates(page);
  await page.getByRole('button', { name: 'Новый шаблон' }).click();
  await page.getByLabel('Название шаблона').fill('Утро');
  await page.getByRole('button', { name: 'Общее время: не задано' }).click();
  const cols = page.getByTestId('duration-wheel').locator('[role=group]');
  await expect(cols).toHaveCount(2);
  // Открытие барабана само не щёлкает.
  expect(await ticks(page)).toBe(0);

  // Три деления минут — три щелчка; значение встаёт, когда колесо остановилось.
  for (let i = 0; i < 3; i++) {
    await cols.nth(1).evaluate((el) => {
      el.scrollTop += 44;
    });
    await page.waitForTimeout(60);
  }
  expect(await ticks(page)).toBe(3);
  await expect(page.getByRole('button', { name: 'Общее время: 15 мин' })).toBeVisible();
  await cols.nth(0).evaluate((el) => {
    el.scrollTop += 44;
  });
  await expect(page.getByRole('button', { name: 'Общее время: 1 ч 15 мин' })).toBeVisible();
  expect(await ticks(page)).toBe(4);

  // Клавиатура: в колесе Tab видит одно выбранное число, стрелка — деление.
  await expect(cols.nth(1).locator('button[tabindex="0"]')).toHaveCount(1);
  await cols.nth(1).locator('button[aria-pressed="true"]').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Общее время: 1 ч 20 мин' })).toBeVisible();

  // Время есть, минут у видов нет — честная подсказка; с минутами вида уходит.
  const hint = page.getByText('В часы за месяц идут минуты видов');
  await expect(hint).toBeVisible();
  // Подсказка говорит «по тапу на название вида» — так и делаем.
  await page.getByRole('button', { name: /^Вид: Силовая/ }).click();
  await page.getByPlaceholder('по желанию', { exact: true }).fill('45');
  await expect(hint).toBeHidden();

  await page.getByRole('button', { name: 'Сохранить шаблон' }).click();
  await expect(page.getByRole('button', { name: /^Утро/ })).toContainText('Силовая · 1 ч 20 мин');
  expect((await templates(page))[0].totalMinutes).toBe(80);

  // Обратно в ноль — время не задано, в записи поля нет.
  await page.getByRole('button', { name: 'Изменить шаблон «Утро»' }).click();
  await page.getByRole('button', { name: 'Общее время: 1 ч 20 мин' }).click();
  await cols.nth(0).evaluate((el) => {
    el.scrollTop = 0;
  });
  await cols.nth(1).evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: 'Общее время: не задано' })).toBeVisible();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Утро/ })).toContainText('Силовая · 45 мин');
  expect('totalMinutes' in (await templates(page))[0]).toBe(false);
});

test('строка без названия: остаётся открытой, в шаблон не попадает', async ({ page }) => {
  await openApp(page, '/more/health');
  await openTemplates(page);
  await page.getByRole('button', { name: 'Новый шаблон' }).click();
  await page.getByLabel('Название шаблона').fill('Утро');
  const add = page.getByRole('button', { name: 'Упражнение', exact: true });
  const editor = page.getByTestId('exercise-editor');
  await add.click();
  await page.getByLabel('Подходы').fill('3');
  // Вторая строка первую не сворачивает: без названия она не упражнение.
  await add.click();
  await expect(editor).toHaveCount(2);
  await editor.nth(1).getByLabel('Название упражнения').fill('Планка');
  await editor.nth(1).getByRole('button', { name: 'Готово' }).click();
  await expect(editor).toHaveCount(1);
  await expect(page.getByTestId('exercise-row')).toContainText('Планка');
  await page.getByRole('button', { name: 'Сохранить шаблон' }).click();
  await expect(page.getByRole('button', { name: /^Утро/ })).toBeVisible();
  expect((await templates(page))[0].items[0].exercises).toStrictEqual([{ name: 'Планка', sets: null, reps: null }]);
});

test('английский интерфейс: в редакторе шаблона и карточке дня нет русских строк', async ({ page }) => {
  await openApp(page, '/more/health', { language: 'en' });
  await seedTemplate(page, {
    name: 'Workout A',
    totalMinutes: 70,
    note: 'Leave 1–2 reps in reserve',
    items: [
      item('run', 12, 2, []),
      item('strength', 45, null, [
        { name: 'Weighted pull-ups', sets: 4, reps: 6, repsTo: 8, weight: '+10–15 kg', rest: '2 min', note: 'Warm-up 1×5–6' },
        { name: 'Neck isometrics', sets: 2, reps: 12, repsTo: 15, unit: 'sec', rest: '30 sec' },
      ]),
    ],
  });
  const cyrillic = /[а-яё]/i;
  const dayCard = page.getByTestId('day-templates');
  await expect(dayCard.getByRole('button', { name: 'From template: Workout A' })).toBeVisible();
  expect(await dayCard.innerText()).not.toMatch(cyrillic);

  await dayCard.getByRole('button', { name: 'Templates', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workout templates' })).toBeVisible();
  expect(await page.locator(SHEET).innerText()).not.toMatch(cyrillic);
  await page.getByRole('button', { name: 'Edit template “Workout A”' }).click();
  await page.getByRole('button', { name: 'Total time: 1 h 10 min' }).click();
  await page.getByTestId('exercise-row').first().click();
  await page.getByRole('button', { name: /^Type: Run/ }).click();
  await expect(page.getByTestId('exercise-editor')).toBeVisible();
  const text = await page.locator(SHEET).innerText();
  expect(text).not.toMatch(cyrillic);
  // Подписи читалки тоже переведены.
  const labels = await page.locator(SHEET).locator('[aria-label]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
  expect(labels.filter((l) => /[а-яё]/i.test(l))).toEqual([]);
  // Первое упражнение раскрыто полями, второе читается строкой.
  expect(text).toContain('2 × 12–15 sec');
  expect(text).toContain('rest 30 sec');
});

test('экран 320: карточка дня, список и редактор шаблона не шире экрана, кнопки целиком', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openApp(page, '/more/health');
  await seedTemplate(page, TEMPLATE_A);
  await seedTemplate(page, { name: 'Контрольный день — очень длинное название шаблона для проверки переноса', items: [item('strength', 0, null, [])] });
  // Меряем внутри своего корня: барабан дней на вкладке — лента шире экрана
  // по замыслу, его дни за краем сюда попадать не должны.
  const fits = async (where: string, root: string) => {
    const wide = await page.evaluate((sel) => {
      const out: string[] = [];
      if (document.documentElement.scrollWidth > window.innerWidth) out.push(`страница ${document.documentElement.scrollWidth}`);
      const box = document.querySelector(sel);
      if (!box) return ['нет корня'];
      for (const el of box.querySelectorAll<HTMLElement>('button, input, textarea')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.left < -0.5 || r.right > window.innerWidth + 0.5) out.push(`${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 24)}: ${Math.round(r.left)}…${Math.round(r.right)}`);
      }
      return out;
    }, root);
    expect(wide, where).toEqual([]);
  };
  await expect(page.getByRole('button', { name: 'По шаблону: Тренировка А' })).toBeVisible();
  await fits('карточка дня', '[data-testid="day-templates"]');
  await openTemplates(page);
  await fits('список шаблонов', SHEET);
  await page.getByRole('button', { name: 'Изменить шаблон «Тренировка А»' }).click();
  await page.getByRole('button', { name: /^Общее время/ }).click();
  await page.getByTestId('exercise-row').nth(1).click();
  await expect(page.getByTestId('exercise-editor')).toBeVisible();
  await fits('редактор шаблона', SHEET);
  // Подвал: «Удалить» и «Сохранить» в одну строку, подписи не рвутся.
  const save = page.getByRole('button', { name: 'Сохранить', exact: true });
  await save.scrollIntoViewIfNeeded();
  const [saveBox, delBox] = await Promise.all([save.boundingBox(), page.getByRole('button', { name: 'Удалить', exact: true }).boundingBox()]);
  expect(Math.round(saveBox!.height)).toBeLessThanOrEqual(52);
  expect(Math.abs(saveBox!.y - delBox!.y)).toBeLessThan(1);
});

// ——— Замечания независимого разбора кода (15.11.2026) ———

test('тап по уже выбранному виду не стирает километры импортированной записи', async ({ page }) => {
  await openApp(page, '/more/health');
  await page.evaluate(async () => {
    const { addWorkout } = await import('/src/features/health/workoutRepo.ts');
    const { todayKey } = await import('/src/lib/dates.ts');
    await addWorkout({
      date: todayKey(), type: 'other', minutes: 60, distanceKm: 12.5, effort: null, note: 'Лыжи',
      source: 'import', groupId: null, customLabel: null, customColor: null,
    });
  });
  await page.getByRole('button', { name: /^Другое/ }).first().click();
  // По плейсхолдеру: у заполненного поля подпись достаётся крестику очистки.
  await expect(page.locator(SHEET).getByText('Дистанция, км')).toBeVisible();
  const km = page.locator(SHEET).getByPlaceholder('по желанию', { exact: true }).nth(1);
  await expect(km).toHaveValue('12,5');
  await page.locator(SHEET).getByRole('button', { name: 'Другое', exact: true }).click();
  await expect(km).toHaveValue('12,5');
  await page.getByRole('button', { name: 'Тяжело' }).click();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator(SHEET)).toHaveCount(0);
  expect((await workouts(page))[0]).toMatchObject({ type: 'other', distanceKm: 12.5, effort: 3 });
});

test('барабан: время не на сетке видно верно и не меняется само; число уходит в форму сразу', async ({ page }) => {
  await openApp(page, '/more/health');
  await seedTemplate(page, { name: 'Не на сетке', totalMinutes: 58, items: [item('strength', 0, null, [])] });
  await openTemplates(page);
  await page.getByRole('button', { name: 'Изменить шаблон «Не на сетке»' }).click();
  await page.getByRole('button', { name: 'Общее время: 58 мин' }).click();
  const cols = page.getByTestId('duration-wheel').locator('[role=group]');
  // 58 минут на колёсах — «1 ч 0 мин», а не «0 ч 0 мин».
  await expect(cols.nth(0).locator('button[aria-pressed="true"]')).toHaveAttribute('aria-label', 'Часы: 1, выбрано');
  await expect(cols.nth(1).locator('button[aria-pressed="true"]')).toHaveAttribute('aria-label', 'Минуты: 0, выбрано');
  // Колёса не трогали — время то же, вопроса при закрытии нет.
  await page.locator(SHEET).getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.locator(SHEET)).toHaveCount(0);
  await expect(page.getByTestId('confirm-sheet')).toHaveCount(0);
  expect((await templates(page))[0].totalMinutes).toBe(58);

  // Прокрутил и «Сохранить» через кадр — намного раньше прежней паузы в
  // 120 мс, после которой значение только уходило в форму: время в записи.
  await openTemplates(page);
  await page.getByRole('button', { name: 'Изменить шаблон «Не на сетке»' }).click();
  await page.getByRole('button', { name: 'Общее время: 58 мин' }).click();
  await cols.nth(1).evaluate(async (el) => {
    el.scrollTop = 88;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    document.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      if (b.textContent?.trim() === 'Сохранить') b.click();
    });
  });
  await expect(page.getByRole('button', { name: /^Не на сетке/ })).toContainText('1 ч 10 мин');
  expect((await templates(page))[0].totalMinutes).toBe(70);

  // Тап по числу и сразу закрыть барабан: встаёт выбранное число, не промежуточное.
  await page.getByRole('button', { name: 'Изменить шаблон «Не на сетке»' }).click();
  await page.getByRole('button', { name: 'Общее время: 1 ч 10 мин' }).click();
  await cols.nth(1).evaluate((el) => {
    const target = [...el.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Минуты: 40');
    target!.click();
  });
  await page.getByRole('button', { name: /^Общее время/ }).click();
  await expect(page.getByTestId('duration-wheel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Общее время: 1 ч 40 мин' })).toBeVisible();
});

test('редактор открывается сверху и из прокрученного списка; шаблоны в карточке дня не мигают «пока нет»', async ({ page }) => {
  // Наблюдатель с первого кадра: текст «Шаблонов пока нет» в карточке дня.
  await page.addInitScript(() => {
    (window as unknown as { __flash: boolean }).__flash = false;
    new MutationObserver(() => {
      const box = document.querySelector('[data-testid="day-templates"]');
      if (box?.textContent?.includes('Шаблонов пока нет')) (window as unknown as { __flash: boolean }).__flash = true;
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await openApp(page, '/more/health');
  for (let i = 1; i <= 14; i++) {
    await seedTemplate(page, { name: `Шаблон ${String(i).padStart(2, '0')}`, items: [item('strength', 0, null, [])] });
  }
  await page.evaluate(() => {
    (window as unknown as { __flash: boolean }).__flash = false;
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'По шаблону: Шаблон 14' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __flash: boolean }).__flash)).toBe(false);

  await openTemplates(page);
  const last = page.getByRole('button', { name: 'Изменить шаблон «Шаблон 14»' });
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect(page.getByLabel('Название шаблона')).toHaveValue('Шаблон 14');
  await expect(page.getByLabel('Название шаблона')).toBeInViewport();
});

test('стрелка порядка, упёршаяся в край, остаётся в фокусе', async ({ page }) => {
  await openApp(page, '/more/health');
  await seedTemplate(page, TEMPLATE_A);
  await openTemplates(page);
  await page.getByRole('button', { name: 'Изменить шаблон «Тренировка А»' }).click();
  // «Брусья» — второе в силовой: одна стрелка вверх — и оно первое.
  await page.getByTestId('exercise-row').nth(2).click();
  const up = page.getByRole('button', { name: 'Поднять упражнение' });
  await up.focus();
  await page.keyboard.press('Enter');
  await expect(up).toBeDisabled();
  await expect(up).toBeFocused();
  // Упёрлась — дальше не двигает и ничего не ломает.
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Готово' }).click();
  await expect(page.getByTestId('exercise-row').nth(1)).toContainText('Брусья с поясом');
});

test('подсказка упражнения берёт подходы с последней из двух тренировок одного дня', async ({ page }) => {
  await openApp(page, '/more/health');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { todayKey } = await import('/src/lib/dates.ts');
    const row = (id: string, createdAt: string, sets: number) => ({
      id, createdAt, updatedAt: createdAt, deletedAt: null, date: todayKey(), type: 'strength', minutes: 0, distanceKm: null,
      effort: null, note: '', source: 'manual', groupId: null, customLabel: null, customColor: null,
      exercises: [{ name: 'Отжимания', sets, reps: 15 }],
    });
    // id нарочно в обратном порядке: порядок по ключу отдал бы утреннюю.
    await db.workouts.bulkAdd([row('b-morning', '2026-11-15T07:00:00.000Z', 3), row('a-evening', '2026-11-15T19:00:00.000Z', 5)] as never[]);
  });
  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  await page.locator(SHEET).getByRole('button', { name: 'Силовая', exact: true }).click();
  await page.getByRole('button', { name: '+ Отжимания' }).click();
  await expect(page.getByTestId('exercise-row')).toContainText('5 × 15');
});

// ——— Находки живых сценариев второго круга (15.11.2026) ———

test('двойной тап по чипу шаблона: второй тап не попадает во въезжающую форму', async ({ page }) => {
  await openApp(page, '/more/health');
  await seedTemplate(page, { ...TEMPLATE_A, name: 'Тренировка А — сила, удар и кардио на всю неделю' });
  const chip = page.getByRole('button', { name: /^По шаблону: Тренировка А/ });
  await chip.scrollIntoViewIfNeeded();
  const box = (await chip.boundingBox())!;
  // Оба края чипа: под правым во въезжающей форме оказывалось «Убрать» вида,
  // под левым — заголовок вида и строка упражнения.
  for (const x of [box.x + box.width - 12, box.x + 40]) {
    await page.touchscreen.tap(x, box.y + box.height / 2);
    await page.waitForTimeout(120);
    await page.touchscreen.tap(x, box.y + box.height / 2);
    await expect(page.getByRole('heading', { name: 'Новая тренировка' })).toBeVisible();
    await expect(page.getByTestId('workout-kind')).toHaveCount(3);
    await expect(page.getByTestId('exercise-editor')).toHaveCount(0);
    await expect(page.locator(`${SHEET} [aria-expanded="true"]`)).toHaveCount(0);
    await page.locator(SHEET).getByRole('button', { name: 'Закрыть' }).click();
    await expect(page.locator(SHEET)).toHaveCount(0);
  }
});

test('барабан: три быстрые стрелки подряд — три деления', async ({ page }) => {
  await openApp(page, '/more/health');
  await openTemplates(page);
  await page.getByRole('button', { name: 'Новый шаблон' }).click();
  await page.getByRole('button', { name: 'Общее время: не задано' }).click();
  const minutes = page.getByTestId('duration-wheel').locator('[role=group]').nth(1);
  await minutes.locator('button[aria-pressed="true"]').focus();
  // Три нажатия без пауз, каждое своей задачей — как автоповтор клавиши.
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })), 0);
    }
  });
  await expect(page.getByRole('button', { name: 'Общее время: 15 мин' })).toBeVisible();
});

test('целые поля упражнения: вставка «12,5» — это 12, а не 125', async ({ page }) => {
  await openApp(page, '/more/health');
  await openTemplates(page);
  await page.getByRole('button', { name: 'Новый шаблон' }).click();
  await page.getByRole('button', { name: 'Упражнение', exact: true }).click();
  await page.getByLabel('Подходы').fill('12,5');
  await expect(page.getByLabel('Подходы')).toHaveValue('12');
  await page.getByLabel('Повторы', { exact: true }).fill('12.5');
  await expect(page.getByLabel('Повторы', { exact: true })).toHaveValue('12');
  await page.getByLabel('Повторы, до').fill('абв15');
  await expect(page.getByLabel('Повторы, до')).toHaveValue('15');
});

// Шаблон по шагам (16.11.2026, канва design/template-steps, вариант А): порядок
// «название → упражнения → дополнительно» виден заголовками, вид нового шаблона
// свёрнут до строки, у упражнения сначала главное. Спрятанное «Подробнее» не
// теряется: свернул — значение осталось и ушло в запись.
test('шаблон по шагам: блоки 1 → 2 → 3, вид и подробности свёрнуты, спрятанное не теряется', async ({ page }) => {
  await openApp(page, '/more/health');
  await openTemplates(page);
  await page.getByRole('button', { name: 'Новый шаблон' }).click();
  const sheet = page.locator(SHEET);

  await expect(sheet.locator('h3')).toHaveText([/^1\s*Название$/, /^2\s*Упражнения$/, /^3\s*Дополнительно/]);
  const top = async (l: Locator) => (await l.boundingBox())!.y;
  const nameField = page.getByLabel('Название шаблона');
  const addExercise = page.getByRole('button', { name: 'Упражнение', exact: true });
  const time = page.getByRole('button', { name: 'Общее время: не задано' });
  expect(await top(nameField)).toBeLessThan(await top(addExercise));
  expect(await top(addExercise)).toBeLessThan(await top(time));

  // Вид — одной строкой: стены чипов до первого упражнения нет.
  await expect(sheet.getByRole('button', { name: 'Бег', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Вид: Силовая/ })).toHaveAttribute('aria-expanded', 'false');

  // Упражнение: название, подходы × повторы – до, «Подробнее», «Убрать», «Готово».
  // Одно упражнение двигать некуда — стрелок нет.
  await addExercise.click();
  const editor = page.getByTestId('exercise-editor');
  await expect(editor.locator('input, textarea')).toHaveCount(4);
  await expect(editor.getByRole('button')).toHaveCount(3);
  await page.getByLabel('Название упражнения').fill('Подтягивания с поясом');
  await page.getByLabel('Подходы').fill('4');
  await page.getByLabel('Повторы', { exact: true }).fill('6');
  const more = editor.getByRole('button', { name: /^Подробнее/ });
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await page.getByLabel('Вес').fill('+10 кг');
  await more.click();
  await expect(page.getByLabel('Вес')).toHaveCount(0);
  await page.getByRole('button', { name: 'Готово' }).click();
  const row = page.getByTestId('exercise-row');
  await expect(row).toContainText('+10 кг');
  // Заполненное раскрыто само: вес не прячется за «Подробнее».
  await row.click();
  await expect(page.getByLabel('Вес')).toHaveValue('+10 кг');
  await page.getByRole('button', { name: 'Готово' }).click();

  // Второй вид приходит раскрытым: выбрать вид — первое, что с ним делают.
  await page.getByRole('button', { name: 'Другой вид тренировки' }).click();
  await sheet.getByRole('button', { name: 'Бег', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Вид: Бег/ })).toBeVisible();

  await nameField.fill('Тренировка А');
  await page.getByRole('button', { name: 'Сохранить шаблон' }).click();
  await expect(page.getByRole('button', { name: /^Тренировка А/ })).toBeVisible();
  const [tpl] = await templates(page);
  expect(tpl.items.map((i) => i.type)).toEqual(['strength', 'run']);
  expect(tpl.items[0].exercises).toStrictEqual([{ name: 'Подтягивания с поясом', sets: 4, reps: 6, weight: '+10 кг' }]);
});
