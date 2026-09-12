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
  ['/home', 'Главная'],
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

test('«Женские дни» скрыты по умолчанию, но включаются в настройках', async ({ page }) => {
  // Раздел намеренно не показан всем подряд: цикл — не то, что должно
  // появляться в меню у человека, которому это не нужно. Но скрытый раздел
  // обязан оставаться находимым, иначе он просто не существует.
  await openApp(page, '/home');
  await expect(page.getByRole('link', { name: /Женские дни/ })).toHaveCount(0);

  await page.goto('/more/settings/sections');
  await expect(page.getByText('Женские дни')).toBeVisible();
});

test('календарь есть в нижней панели', async ({ page }) => {
  // Раньше экран существовал, но ссылки на него не было нигде — регрессия,
  // которая тихо возвращается при любой правке раскладки по умолчанию.
  await openApp(page);
  const bar = page.locator('nav').last();
  await expect(bar.getByRole('link', { name: /Календарь/ })).toBeVisible();
});
