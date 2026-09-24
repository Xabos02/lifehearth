import { test, expect, openApp } from './fixtures';

// Срок-период у задачи: «сдать лист в кадры с 10 по 25». Дедлайн остаётся
// dueDate (просрочка и напоминание по нему), startDate добавляет окно — с
// него задача видна в «Сегодня» и на каждом дне окна в календаре.

import { addDaysKey, todayKey } from '../src/lib/dates';

test('задача с периодом: создание, подпись диапазона, «Сегодня», календарь', async ({ page }) => {
  const start = addDaysKey(todayKey(), -2);
  const due = addDaysKey(todayKey(), 3);

  await openApp(page, '/tasks');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  await page.locator('textarea[placeholder="Что нужно сделать?"]').fill('Сдать лист в кадры');

  // Чип «Период» раскрывает поле начала; «Срок» превращается в «Сдать до».
  await page.getByRole('button', { name: 'Период' }).click();
  await page.getByLabel('Начало').fill(start);
  await page.getByLabel('Сдать до').fill(due);
  await page.getByRole('button', { name: 'Сохранить' }).click();
  // Дождаться закрытия шита: пока он в DOM (анимация), «последний div с
  // текстом» — это шит, и его innerText пуст (текст живёт в value textarea).
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toHaveCount(0);

  // Подпись — диапазон, а не одна дата (дедлайн «через 3 дня» — датой).
  const row = page.getByText('Сдать лист в кадры');
  await expect(row).toBeVisible();
  const label = await page
    .locator('div')
    .filter({ hasText: 'Сдать лист в кадры' })
    .last()
    .innerText();
  expect(label).toMatch(/–|—/);

  // Сегодня — внутри окна: задача в списке «Сегодня».
  await openApp(page, '/');
  await expect(page.getByText('Сдать лист в кадры')).toBeVisible();

  // Календарь: день внутри окна (вчера) содержит задачу, хотя дедлайн позже.
  await openApp(page, '/calendar');
  const yesterday = addDaysKey(todayKey(), -1);
  const dayNum = Number(yesterday.slice(8, 10));
  // Ячейка дня подписана полной датой («11 августа 2026…») — ловим по началу.
  await page
    .getByRole('button', { name: new RegExp(`^${dayNum} `) })
    .first()
    .click();
  await expect(page.getByText('Сдать лист в кадры')).toBeVisible();

  // Переживает перезагрузку.
  await page.reload();
  await openApp(page, '/tasks');
  await expect(page.getByText('Сдать лист в кадры')).toBeVisible();
});

test('период из быстрой строки: «с 10 по 25 сентября» — подсказка и диапазон', async ({ page }) => {
  // Быстрая строка раньше понимала только точечную дату; период приходилось
  // выставлять в полной форме. Теперь «с 10 по 25 сентября» — сразу окно.
  //
  // Часы прибиты к 1 августа: подпись окна зависит от сегодняшнего дня. 24
  // сентября дедлайн «25 сентября» — это «завтра», и подпись законно
  // становится «10 сентября — Завтра»; после 25-го окно уезжает в следующий
  // год. Тест без часов был зелёным ровно до 23 сентября и потом блокировал
  // бы любую выкатку.
  await page.clock.setFixedTime(new Date('2026-08-01T10:00:00'));
  await openApp(page, '/tasks');
  const input = page.getByPlaceholder('Что нужно сделать?');
  await input.fill('ремонт с 10 по 25 сентября');
  // Подсказка под полем показывает разобранный диапазон до создания.
  await expect(page.getByText('10–25 сентября')).toBeVisible();
  await input.press('Enter');

  // Задача создана с окном: заголовок чист, подпись — диапазон.
  await expect(page.getByText('ремонт', { exact: true })).toBeVisible();
  await expect(page.getByText('10–25 сентября')).toBeVisible();
});

test('чип «Период» выключается — задача сохраняется обычной датой', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  await page.locator('textarea[placeholder="Что нужно сделать?"]').fill('Обычная задача');
  await page.getByRole('button', { name: 'Период' }).click();
  await expect(page.getByLabel('Начало')).toBeVisible();
  await page.getByRole('button', { name: 'Период' }).click();
  await expect(page.getByLabel('Начало')).toHaveCount(0);
  await page.getByLabel('Срок').fill(todayKey());
  await page.getByRole('button', { name: 'Сохранить' }).click();
  // Дождаться закрытия шита: пока он открыт, список под ним не проверить.
  await expect(page.locator('textarea[placeholder="Что нужно сделать?"]')).toHaveCount(0);
  await expect(page.getByText('Обычная задача')).toBeVisible();
  await expect(page.locator('#app-scroll').getByText('Сегодня', { exact: true })).toBeVisible();
});

test('подсказка быстрого ввода уходит сама, как только ею воспользовались', async ({ page }) => {
  // Совет занимает над списком 165px и висел там, пока его не закроют руками:
  // тот, кто уже понял, платил этой полосой при каждом заходе. Задача,
  // добавленная той самой строкой, — доказательство, что совет сработал.
  await openApp(page, '/tasks');
  const hint = page.getByText('Быстрое добавление');
  await expect(hint).toBeVisible();

  await page.getByPlaceholder('Что нужно сделать?').first().fill('Позвонить в сервис');
  await page.getByPlaceholder('Что нужно сделать?').first().press('Enter');

  await expect(page.getByText('Позвонить в сервис')).toBeVisible();
  await expect(hint, 'подсказка осталась после того, как ею воспользовались').toHaveCount(0);

  // И не возвращается после перезагрузки: решение записано, а не забыто.
  await page.reload();
  await expect(page.getByText('Позвонить в сервис')).toBeVisible();
  await expect(hint).toHaveCount(0);
});
