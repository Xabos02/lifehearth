import { test, expect, openApp } from './fixtures';
import { addDaysKey, todayKey } from '../src/lib/dates';

// Раздел «Здоровье» (задача 14): спорт-календарь, ритм «через день», цель
// недели, замеры, импорт CSV.

test('тренировка отмечается с плавающей кнопки и видна в ритме, кольце, календаре', async ({ page }) => {
  await openApp(page, '/more/health');
  const status = page.getByTestId('sport-status');
  await expect(status).toContainText('Первая тренировка');
  await expect(status).toContainText('0/3');

  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  await page.getByRole('button', { name: 'Гири', exact: true }).click();
  await page.getByRole('button', { name: 'Тяжело' }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();

  await expect(status).toContainText('Сегодня уже была');
  await expect(status).toContainText('1/3');
  await expect(status).toContainText('Последняя — сегодня, гири');
  // Точка в сегодняшней ячейке недели и строка в «Недавних».
  await expect(page.getByTestId('workout-week').getByRole('button', { name: /тренировок: 1/ })).toHaveCount(1);
  await expect(page.getByText('тяжело').first()).toBeVisible();

  const stored = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return db.workouts.toArray();
  });
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ type: 'kettlebell', minutes: 30, effort: 3, source: 'manual' });
});

/** Засеять одну тренировку на дату — минуя форму, чтобы проверять экран, а не ввод. */
async function seedWorkout(page: import('@playwright/test').Page, date: string, id = 'w-seed') {
  await page.evaluate(
    async ([d, wid]) => {
      const { db } = await import('/src/db/db.ts');
      const now = new Date().toISOString();
      await db.workouts.put({
        id: wid, createdAt: now, updatedAt: now, deletedAt: null,
        date: d, type: 'kettlebell', minutes: 30, distanceKm: null, effort: null, note: '', source: 'manual',
      });
    },
    [date, id],
  );
}

test('ритм «через день»: вчера была — сегодня отдых, позавчера — сегодня тренировка', async ({ page }) => {
  await openApp(page, '/more/health');
  const today = todayKey();
  const status = page.getByTestId('sport-status');

  await seedWorkout(page, addDaysKey(today, -1));
  await expect(status).toContainText('Сегодня — отдых');
  await expect(status).toContainText('Последняя — вчера');

  await seedWorkout(page, addDaysKey(today, -2));
  await expect(status).toContainText('Сегодня — тренировка');
  await expect(status).toContainText('Последняя — позавчера');

  // При цели 6 дней «отдых» после вчерашней не предлагается.
  await seedWorkout(page, addDaysKey(today, -1));
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Цель: больше' }).click();
  await expect(page.getByTestId('weekly-goal')).toHaveText('6');
  await expect(status).toContainText('Сегодня — тренировка');
});

test('цель недели меняется кнопками и переживает перезагрузку', async ({ page }) => {
  await openApp(page, '/more/health');
  await page.getByRole('button', { name: 'Цель: больше' }).click();
  await expect(page.getByTestId('weekly-goal')).toHaveText('4');
  await expect(page.getByTestId('sport-status')).toContainText('0/4');
  await page.reload();
  await expect(page.getByTestId('weekly-goal')).toHaveText('4');
});

test('дни и месяц переключаются; тренировка задним числом ставится на выбранный день', async ({ page }) => {
  // Среда середины месяца: позавчера — в этом же месяце и в той же сетке.
  await page.clock.setFixedTime(new Date('2026-09-16T12:00:00'));
  await openApp(page, '/more/health');
  const wheel = page.getByTestId('workout-week');
  // Все дни, а не только видимые читалке: ей открыт один выбранный.
  const days = wheel.locator('button');
  // Правый край барабана — сегодня, и он выбран: в будущее лента не крутится.
  await expect(days.last()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Сегодня', exact: true })).toHaveCount(0);

  // Позавчера: нажатие докручивает ленту, выбор уходит, когда она встала.
  const before = days.nth(-3);
  const label = ((await before.getAttribute('aria-label')) ?? '').split(',')[0];
  await before.click();
  await expect(days.nth(-3)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('wheel-caption')).toContainText('позавчера');
  // Выбор доезжает до экрана через 120 мс после остановки ленты — ждём его.
  await expect(page.getByRole('heading', { name: '14 сентября, понедельник' })).toBeVisible();
  await page.getByRole('button', { name: '+ Тренировка' }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(days.nth(-3)).toHaveAttribute('aria-label', new RegExp(label + '.*тренировок: 1'));

  // «Сегодня» возвращает ленту на правый край.
  await page.getByRole('button', { name: 'Сегодня', exact: true }).click();
  await expect(days.last()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Сегодня', exact: true })).toHaveCount(0);

  // В месячной сетке у того дня тоже точка, а стрелка уводит в прошлый месяц и обратно.
  await page.getByRole('button', { name: 'Месяц' }).click();
  await expect(page.getByTestId('workout-month').getByRole('button', { name: /тренировок: 1/ })).toHaveCount(1);
  const title = page.locator('h2.text-lg').first();
  const thisMonth = await title.innerText();
  await page.getByRole('button', { name: 'Предыдущий месяц' }).click();
  await expect(title).not.toHaveText(thisMonth);
  await page.getByRole('button', { name: 'Следующий месяц' }).click();
  await expect(title).toHaveText(thisMonth);

  // День, выбранный в сетке, — центр барабана после возврата к «Дням».
  await page.getByTestId('workout-month').getByRole('button', { name: new RegExp('^' + label) }).click();
  await page.getByRole('button', { name: 'Дни' }).click();
  await expect(days.nth(-3)).toHaveAttribute('aria-pressed', 'true');
});

test('занятие из двух видов — одна тренировка: в подписи дня и после правки одного вида', async ({ page }) => {
  await openApp(page, '/more/health');
  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  await page.getByRole('button', { name: 'Силовая', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить ещё вид', exact: true }).click();
  // Второй набор чипов — у второго вида.
  await page.getByRole('button', { name: 'Растяжка', exact: true }).nth(1).click();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();

  // Подпись дня для чтения с экрана считала виды: «тренировок: 2» за одно занятие.
  await expect(page.getByTestId('workout-week').getByRole('button', { name: /тренировок: 1/ })).toHaveCount(1);
  const monthTile = page.getByText('тренировок за месяц', { exact: true }).locator('..');
  await expect(monthTile.locator('p').first()).toHaveText('1');

  // Правка минут одного вида выводила его из занятия (groupId → null), и
  // «тренировок за месяц» становилось 2.
  await page.getByRole('button', { name: /^Растяжка/ }).first().click();
  await page.getByPlaceholder('по желанию').first().fill('25');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Растяжка.*25 мин/ }).first()).toBeVisible();
  await expect(monthTile.locator('p').first()).toHaveText('1');

  const rows = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.workouts.toArray()).map((w) => ({ groupId: w.groupId, type: w.type, minutes: w.minutes }));
  });
  const groups = rows.map((r) => r.groupId);
  // Минуты по виду подставляются при смене вида: у силовой — её 45, а не 30 бега.
  expect(rows.find((r) => r.type === 'strength')?.minutes).toBe(45);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toBeTruthy();
  expect(groups[1]).toBe(groups[0]);
});

test('замер веса: карточка показывает значение, второй за день заменяет первый', async ({ page }) => {
  await openApp(page, '/more/health');
  await page.getByRole('button', { name: 'Замеры' }).click();
  const card = page.getByTestId('measure-weight');
  await expect(card).toContainText('Замеров пока нет');

  await card.getByRole('button', { name: '+ замер' }).click();
  await page.getByPlaceholder('75').fill('78,4');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(card).toContainText('78,4');

  await card.getByRole('button', { name: '+ замер' }).click();
  await page.getByPlaceholder('75').fill('78.1');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(card).toContainText('78,1');
  const logs = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.metricLogs.toArray()).filter((l) => !l.deletedAt);
  });
  expect(logs).toHaveLength(1);
});

test('импорт CSV из Strava добавляет тренировки и не плодит копии', async ({ page }) => {
  await openApp(page, '/more/health');
  const csv = [
    'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Moving Time',
    '1,"Sep 1, 2026, 7:01:00 AM","Morning Run",Run,2100,5.21,1920',
    '2,"Sep 3, 2026, 6:02:11 PM","Gym",Weight Training,3300,,3300',
  ].join('\n');
  page.on('dialog', (d) => void d.accept());
  await page.getByTestId('workout-csv').setInputFiles({ name: 'activities.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect.poll(async () =>
    page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      return (await db.workouts.toArray()).length;
    }),
  ).toBe(2);

  // Повтор того же файла — «уже есть», записей по-прежнему две.
  await page.getByTestId('workout-csv').setInputFiles({ name: 'activities.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText('Все записи из файла уже есть.')).toBeVisible();
  const n = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.workouts.toArray()).length;
  });
  expect(n).toBe(2);
});

test('раздел есть в списке «Главной» и открывается оттуда', async ({ page }) => {
  await openApp(page, '/home');
  // «Главная» показывает первые HOME_VISIBLE_STEP разделов, остальные — за
  // «Показать ещё» (1.32.0). «Здоровье» в пятёрку не входит, список надо
  // раскрыть — как это делает человек.
  const more = page.getByRole('button', { name: /Показать ещё/ });
  while (await more.isVisible().catch(() => false)) await more.click();
  await page.getByRole('link', { name: /Здоровье/ }).click();
  await expect(page.getByRole('heading', { name: 'Здоровье' })).toBeVisible();
});

test('строка спорта на «Сегодня»: появляется после первой тренировки, отмечает одним жестом', async ({ page }) => {
  // Часы — на среду: «позавчера» той же недели. По живым часам в понедельник и
  // вторник позавчера уходило на прошлую неделю, счётчик честно писал «1 из 3»,
  // и тест краснел по дням недели, а не из-за кода (CI 29.09, вторник).
  const today = '2026-09-16';
  await page.clock.setFixedTime(new Date(`${today}T12:00:00`));
  await openApp(page, '/');
  // До первой тренировки строки нет — новичку она не навязывается.
  await expect(page.getByTestId('sport-today')).toHaveCount(0);

  await seedWorkout(page, addDaysKey(today, -2));
  const line = page.getByTestId('sport-today');
  await expect(line).toContainText('Сегодня — тренировка');
  await expect(line).toContainText('позавчера · гири');

  await line.getByRole('button', { name: 'Отметить' }).click();
  await page.getByRole('button', { name: 'Бокс', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(line).toContainText('Сегодня уже была');
  await expect(line).toContainText('бокс · 30 мин');
  await expect(line).toContainText('2 из 3 на неделе');
});

test('вес из профиля попадает в «Замеры», а замер веса — на «Главную»', async ({ page }) => {
  await openApp(page, '/more/health');
  await page.getByRole('button', { name: 'Замеры' }).click();
  await page.getByTestId('measure-weight').getByRole('button', { name: '+ замер' }).click();
  await page.getByPlaceholder('75').fill('81,5');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('measure-weight')).toContainText('81,5');
  // Профиль догоняет дневник следующей записью (logMeasure): карточка уже
  // показывает замер, а профиль — через миллисекунды. Ждём значение, а не
  // читаем разово — разовое чтение падало через раз под нагрузкой.
  const weight = () =>
    page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      return (await db.settings.get('app'))?.profile?.weightKg ?? null;
    });
  await expect.poll(weight).toBe(81.5);
});

test('удалённый последний замер веса снимает число и с профиля', async ({ page }) => {
  await openApp(page, '/more/health');
  await page.getByRole('button', { name: 'Замеры' }).click();
  const card = page.getByTestId('measure-weight');
  await card.getByRole('button', { name: '+ замер' }).click();
  await page.getByPlaceholder('75').fill('78,4');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(card).toContainText('78,4');
  page.on('dialog', (d) => void d.accept());
  await card.getByRole('button', { name: '+ замер' }).click();
  await page.getByRole('button', { name: 'Удалить замер за этот день' }).click();
  await expect(card).toContainText('Замеров пока нет');
  // Та же гонка, что выше: профиль догоняет дневник следующей записью.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts');
        return (await db.settings.get('app'))?.profile?.weightKg ?? null;
      }),
    )
    .toBeNull();
});

test('масштаб «Месяц» переживает переход на «Замеры» и обратно', async ({ page }) => {
  await openApp(page, '/more/health');
  await page.getByRole('button', { name: 'Месяц' }).click();
  await page.getByRole('button', { name: 'Замеры' }).click();
  await page.getByRole('button', { name: 'Спорт' }).click();
  await expect(page.getByTestId('workout-month')).toBeVisible();
});
