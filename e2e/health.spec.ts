import { test, expect, openApp } from './fixtures';
import { addDaysKey, todayKey, weekStartKey } from '../src/lib/dates';

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

test('месяц и неделя переключаются; тренировка задним числом ставится на выбранный день', async ({ page }) => {
  await openApp(page, '/more/health');
  await page.getByRole('button', { name: 'Месяц' }).click();
  await expect(page.getByTestId('workout-month')).toBeVisible();
  await page.getByRole('button', { name: 'Неделя' }).click();
  await expect(page.getByTestId('workout-week')).toBeVisible();

  // Выбираем первый день показанной недели (понедельник) и добавляем на него.
  const monday = page.getByTestId('workout-week').getByRole('button').first();
  const mondayLabel = (await monday.getAttribute('aria-label')) ?? '';
  await monday.click();
  await page.getByRole('button', { name: '+ Тренировка' }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('workout-week').getByRole('button').first()).toHaveAttribute(
    'aria-label',
    new RegExp(mondayLabel.split(',')[0] + '.*тренировок: 1'),
  );
  // Кольцо видит понедельник: он в этой же неделе.
  await expect(page.getByTestId('sport-status')).toContainText('1/3');

  // В месячной сетке у понедельника тоже точка, а стрелка уводит в прошлый месяц и обратно.
  await page.getByRole('button', { name: 'Месяц' }).click();
  await expect(page.getByTestId('workout-month').getByRole('button', { name: /тренировок: 1/ })).toHaveCount(1);
  const title = page.locator('h2.text-lg').first();
  const thisMonth = await title.innerText();
  await page.getByRole('button', { name: 'Предыдущий месяц' }).click();
  await expect(title).not.toHaveText(thisMonth);
  await page.getByRole('button', { name: 'Следующий месяц' }).click();
  await expect(title).toHaveText(thisMonth);

  // Будущие дни выбрать нельзя: тренировку туда не записать.
  await page.getByRole('button', { name: 'Неделя' }).click();
  await page.getByRole('button', { name: 'Следующая неделя' }).click();
  const nextMonday = addDaysKey(weekStartKey(todayKey()), 7);
  const cells = page.getByTestId('workout-week').getByRole('button');
  await expect(cells.first()).toBeDisabled();
  await expect(cells.first()).toHaveAttribute('aria-label', /ещё не наступил/);
  expect(nextMonday > todayKey()).toBe(true);
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
  await page.getByRole('link', { name: /Здоровье/ }).click();
  await expect(page.getByRole('heading', { name: 'Здоровье' })).toBeVisible();
});

test('строка спорта на «Сегодня»: появляется после первой тренировки, отмечает одним жестом', async ({ page }) => {
  await openApp(page, '/');
  // До первой тренировки строки нет — новичку она не навязывается.
  await expect(page.getByTestId('sport-today')).toHaveCount(0);

  await seedWorkout(page, addDaysKey(todayKey(), -2));
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
  const profile = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.settings.get('app'))?.profile;
  });
  expect(profile?.weightKg).toBe(81.5);
});
