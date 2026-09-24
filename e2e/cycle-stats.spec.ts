import type { Page } from '@playwright/test';
import { test, expect, openApp, collectErrors } from './fixtures';
import { addDaysKey } from '../src/lib/dates';

// Экран «Женские дни» говорит об одних и тех же циклах: «в среднем»,
// «Статистика», карточка «Циклы заметно разной длины» и пометки «не
// учитывается» в обзоре года считаются по одной выборке (poolForPrediction).
//
// Что было (перепроверка 24.09): цикл обычной длины с одним неотмеченным днём
// менструации выпадал из «Статистики» и в обзоре года получал «не
// учитывается» без видимой причины; карточка считала по всем циклам и писала
// «самый длинный 65» над «Статистикой» с «28 и 40»; «разница между соседними»
// сравнивала циклы через голову выпавшего; при 15 циклах по 24 дня «Циклов
// учтено 12», а в обзоре года 14 циклов без единой пометки.
//
// Замер — тексты экрана: арифметику держат юниты (stats, anomalies, predict),
// здесь — что экран берёт её из одного места. Часы зафиксированы: окна
// «полгода» и «12 месяцев» считаются от сегодняшнего дня.

const TODAY = '2026-07-25';

/** Менструации прямо в Dexie и один пересчёт циклов штатным repo.
 *  skip — день менструации, который «забыли» отметить. */
async function seedPeriods(page: Page, periods: { from: string; days: number; skip?: number }[]) {
  const dates = periods.flatMap(({ from, days, skip }) =>
    Array.from({ length: days }, (_, i) => i)
      .filter((i) => i !== skip)
      .map((i) => addDaysKey(from, i)),
  );
  await page.evaluate(async (dates) => {
    const { db } = await import('/src/db/db.ts');
    const repo = await import('/src/lib/cycle/cycleRepo.ts');
    const ts = new Date().toISOString();
    await repo.ensureCycleSetup();
    await db.cycleDays.bulkPut(
      dates.map((date) => ({
        date,
        bleeding: 'medium' as const,
        isBleedingDay: 1 as const,
        symptomKeys: [],
        createdAt: ts,
        updatedAt: ts,
        source: 'user' as const,
      })),
    );
    await repo.rebuildCycles();
  }, dates);
}

const statsSection = (page: Page) =>
  page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Статистика', exact: true }) });

test('«в среднем», «Статистика», карточка и обзор года — об одних циклах', async ({ page }) => {
  const errors = collectErrors(page);
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00`));
  await openApp(page, '/more/cycle');
  const s0 = addDaysKey(TODAY, -158);
  await seedPeriods(page, [
    // 22 дня; третий день менструации не отмечен — derive ставит пропуски,
    // но длину от начала до начала это не меняет.
    { from: s0, days: 5, skip: 2 },
    // 40 дней.
    { from: addDaysKey(s0, 22), days: 5 },
    // «65 дней»: менструацию посередине не отметили вовсе — это два цикла.
    { from: addDaysKey(s0, 62), days: 5 },
    // 28 дней, за ним текущий.
    { from: addDaysKey(s0, 127), days: 5 },
    { from: addDaysKey(s0, 155), days: 3 },
  ]);
  await openApp(page, '/more/cycle');

  // Учтены 22, 40 и 28 — все, кроме искажённого пропуском 65.
  const stats = statsSection(page);
  await expect(stats.getByText('Циклов учтено', { exact: true })).toBeVisible();
  await expect(stats.getByText('3', { exact: true })).toBeVisible();
  await expect(stats.getByText('22 и 40 дней', { exact: true })).toBeVisible();
  // Соседи подряд — только 22 и 40; 40 и 28 разделены выпавшим циклом.
  await expect(stats.getByText('18 дней', { exact: true })).toBeVisible();
  await expect(page.getByText('в среднем 30 дней', { exact: true })).toBeVisible();

  // Карточка — о тех же циклах, что и «Статистика» под ней.
  await expect(page.getByText('Циклы заметно разной длины', { exact: true })).toBeVisible();
  await expect(
    page.getByText('За полгода самый короткий цикл 22 дня, самый длинный 40 — разница 18 дней.', {
      exact: true,
    }),
  ).toBeVisible();
  // Подпись прогноза называет ту же причину ширины: размах своих циклов.
  await expect(
    page.getByText('Прогноз ориентировочный: разница между вашими циклами больше двух недель.', {
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Обзор за год →', exact: true }).click();
  const rows = page.getByTestId('year-cycle');
  await expect(rows).toHaveCount(4);
  // «Не учитывается» — только у искажённого пропуском, у цикла с забытым
  // днём пометки нет.
  await expect(rows.filter({ hasText: '65 дней' })).toContainText('не учитывается');
  await expect(rows.filter({ hasText: '22 дня' })).not.toContainText('не учитывается');
  await expect(page.getByText('не учитывается', { exact: true })).toHaveCount(1);

  expect(errors).toEqual([]);
});

test('годный цикл старше последних 12 помечен с причиной, а не голым «не учитывается»', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.clock.setFixedTime(new Date(`${TODAY}T12:00:00`));
  await openApp(page, '/more/cycle');
  // 15 завершённых циклов по 24 дня и текущий. В обзор года (с 1 августа
  // 2025) попадают 14 — со второго по пятнадцатый.
  const s0 = addDaysKey(TODAY, -363);
  await seedPeriods(
    page,
    Array.from({ length: 16 }, (_, k) => ({ from: addDaysKey(s0, 24 * k), days: k === 15 ? 3 : 5 })),
  );
  await openApp(page, '/more/cycle');

  const stats = statsSection(page);
  await expect(stats.getByText('Циклов учтено', { exact: true })).toBeVisible();
  await expect(stats.getByText('12', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Обзор за год →', exact: true }).click();
  const rows = page.getByTestId('year-cycle');
  await expect(rows).toHaveCount(14);
  // Список — от нового к старому: две последние строки — циклы, которые в
  // обзоре есть, а в 12 учтённых уже нет.
  const older = 'не учитывается — в расчёт идут последние 12 циклов';
  await expect(page.getByText(older, { exact: true })).toHaveCount(2);
  await expect(rows.nth(12)).toContainText(older);
  await expect(rows.nth(13)).toContainText(older);
  await expect(rows.nth(11)).not.toContainText('не учитывается');
  await expect(page.getByText('не учитывается', { exact: true })).toHaveCount(0);

  expect(errors).toEqual([]);
});
