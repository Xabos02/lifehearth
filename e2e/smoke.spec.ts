import { test, expect, openApp, collectErrors } from './fixtures';

// Каждый экран должен открываться и не ронять консоль. Скучный тест, но
// именно он ловит то, что ломается чаще всего: переименованный экспорт,
// упавший хук, забытый роут.
//
// Список маршрутов держим здесь руками, а не тянем из sections.ts: реестр
// разделов сам был источником дефекта (экран /calendar существовал, а ссылки
// на него не было ни одной — попасть можно было только вводом URL). Тест,
// выведенный из того же реестра, такую дыру не заметил бы.
const ROUTES = [
  ['/', 'Сегодня'],
  ['/tasks', 'Задачи'],
  ['/notes', 'Заметки'],
  ['/calendar', 'Календарь'],
  ['/goals', 'Цели'],
  ['/stats', 'Статистика'],
  ['/home', 'Ещё'],
  ['/more/finance', 'Финансы'],
  ['/more/focus', 'Фокус'],
  ['/more/habits', 'Привычки'],
  ['/more/learning', 'Обучение'],
  ['/more/energy', 'Энергия'],
  ['/more/health', 'Здоровье'],
  ['/more/places', 'Места'],
  ['/more/family', 'Семья'],
  ['/more/cycle', 'Женские дни'],
  ['/more/cycle/year', 'Год'],
  ['/more/cycle/report', 'Отчёт для врача'],
] as const;

for (const [path, title] of ROUTES) {
  test(`экран ${title} открывается без ошибок`, async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page, path);
    // Заголовок экрана, а не «#root не пуст»: оболочка с панелью отрисуется
    // даже там, где маршрут не совпал, и слабая проверка это пропустит —
    // ровно так первый вариант этого теста и прошёл на пустой странице.
    await expect(page.locator('h1').first()).toHaveText(new RegExp(title, 'i'));
    expect(errors, `ошибки на ${path}`).toEqual([]);
  });
}

test('«Женские дни» в женском профиле видны на «Ещё» сразу, без похода в настройки', async ({ page }) => {
  // Раздел существует только в женском профиле, и выбор пола — уже включение.
  // Видно его без «Показать ещё»: пока раздел не расставляли, он первый.
  await openApp(page, '/home');
  await expect(page.getByRole('link', { name: /Женские дни/ })).toBeVisible();

  await page.goto('/more/settings/sections');
  await expect(page.locator('[data-zone="enabled"]').getByText('Женские дни', { exact: true })).toBeVisible();
});

test('до календаря можно дойти: вкладка «Ещё» ведёт в него', async ({ page }) => {
  // Раньше экран существовал, но ссылки на него не было нигде — регрессия,
  // которая тихо возвращается при любой правке раскладки по умолчанию.
  // С редизайна календарь не в нижней панели, а в списке разделов «Ещё».
  await openApp(page);
  const bar = page.locator('nav').last();
  await bar.getByRole('link', { name: /Ещё/ }).click();
  await expect(page.locator('main a[href="/calendar"]').first()).toBeVisible();
});
