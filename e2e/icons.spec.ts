import { expect } from '@playwright/test';
import { openApp, test } from './fixtures';

// Метрика иконок. Проверяется НАСТОЯЩИЙ штрих в пикселях, а не атрибут: у
// lucide stroke-width задан в системе координат 24×24, поэтому один и тот же
// атрибут даёт разную толщину на разных размерах. Именно это и было сломано —
// от 1.02px на мелких иконках до 2.92px на крупных.
//
// real = attr * size / 24

/** Маршруты, которые дают заметно разный набор иконок. Адреса настоящие: у
 *  приложения нет маршрута-заглушки, и опечатка вроде «/today» вместо «/»
 *  отрисовала бы голый каркас — тест прошёл бы, ничего не измерив. Поэтому
 *  openRoute ниже требует заголовок экрана. */
const ROUTES = [
  '/', '/tasks', '/home', '/notes', '/goals', '/stats', '/calendar', '/search',
  '/more/finance', '/more/habits', '/more/learning', '/more/energy', '/more/health', '/more/places',
  '/more/focus', '/more/family', '/more/cycle', '/more/trash',
  // Настроек тут сначала не было — и мимо замера прошла иконка, сжатая флексом
  // с 18 до 15px: реальный штрих 1.27px вместо 1.5. Ровно та ошибка, ради
  // которой шкала и вводилась.
  '/more/settings', '/more/settings/sections', '/more/settings/install',
  // Вторая серия дыр, найденная аудитом: на этих экранах жили 21 (три кнопки
  // шапки ИИ), 19 (стрелки ИИ), 30 (заглушка ИИ), 26 (компас 404) и 13
  // (метаданные ответа) — всё мимо замера, потому что маршрута не было в
  // списке. Дырка не закрывается один раз: закрывать надо весь список.
  '/more/ai', '/home/profile', '/share',
  '/more/cycle/settings', '/more/cycle/year', '/more/cycle/report',
  // Несуществующий адрес — экран «Не найдено» тоже рисует иконку.
  '/такого-экрана-нет',
];

/** Открыть маршрут и убедиться, что экран действительно отрисовался.
 *
 *  Без повторного засева: флаги онбординга уже в IndexedDB после первого
 *  openApp, а полная перезагрузка со сбросом на каждый из двух десятков
 *  маршрутов — это втрое больше загрузок и выход за таймаут. */
async function openRoute(page: import('@playwright/test').Page, route: string) {
  await page.goto(route);
  await expect(page.locator('header h1')).toBeVisible();
  await page.waitForLoadState('networkidle').catch(() => {});
}

interface Glyph {
  name: string;
  size: number;
  real: number;
  /** Что просили в разметке (атрибут width), null у чужих svg без него. */
  asked: number | null;
  /** Насколько раскладка ужала иконку против заданного. */
  drift: number;
}

async function collectGlyphs(page: import('@playwright/test').Page): Promise<Glyph[]> {
  return page.evaluate(() => {
    const out: { name: string; size: number; real: number; asked: number | null; drift: number }[] = [];
    for (const svg of document.querySelectorAll<SVGElement>('svg.lucide')) {
      const box = svg.getBoundingClientRect();
      if (!box.width || !box.height) continue; // скрытые не считаем
      // Атрибут может быть переопределён CSS — берём вычисленное значение,
      // именно оно и рисуется.
      const attr = parseFloat(getComputedStyle(svg).strokeWidth);
      if (!Number.isFinite(attr)) continue;
      const size = Math.round(box.width);
      // Заданный размер — тот, что в разметке; фактический — то, во что его
      // превратила раскладка. Расхождение и есть «съеденная флексом» иконка.
      const asked = parseFloat(svg.getAttribute('width') ?? '');
      out.push({
        name: svg.getAttribute('class')?.split(/\s+/).find((c) => c.startsWith('lucide-')) ?? '?',
        size,
        real: Math.round((attr * size) / 24 / 0.01) * 0.01,
        asked: Number.isFinite(asked) ? asked : null,
        drift: Number.isFinite(asked) ? Math.round(Math.abs(box.width - asked) * 100) / 100 : 0,
      });
    }
    return out;
  });
}

test('штрих иконок одинаков в пикселях независимо от размера', async ({ page }) => {
  test.setTimeout(120_000); // два десятка маршрутов
  await openApp(page);
  const all: Glyph[] = [];
  for (const route of ROUTES) {
    await openRoute(page, route);
    all.push(...(await collectGlyphs(page)));
  }
  expect(all.length, 'иконки вообще не нашлись — тест бы прошёл впустую').toBeGreaterThan(40);

  // Самопроверка измерителя: пока правило .lucide{stroke-width:1.75} стояло в
  // CSS, разброс был ~2.9x. Если измеритель вдруг начнёт возвращать одно и то
  // же число для всех, тест обязан об этом узнать — поэтому размеры тоже
  // должны быть разными.
  const sizes = new Set(all.map((g) => g.size));
  expect(sizes.size, 'все иконки одного размера — измерять нечего').toBeGreaterThan(2);

  const reals = all.map((g) => g.real);
  const min = Math.min(...reals);
  const max = Math.max(...reals);
  // Допуск: обычный вес 1.5, акцентный 2.0, на заливке 2.4. Разброс внутри
  // этой вилки законен, вне — значит где-то остался старый механизм.
  expect(min, `слишком тонкий штрих: ${JSON.stringify(all.filter((g) => g.real === min))}`).toBeGreaterThanOrEqual(1.4);
  expect(max, `слишком жирный штрих: ${JSON.stringify(all.filter((g) => g.real === max))}`).toBeLessThanOrEqual(2.5);
});

test('размеры иконок — только со ступеней шкалы', async ({ page }) => {
  // 14/16/18/20/24 — рабочие ступени, 32 и 40 — дисплейные. Всё остальное
  // означает, что в разметку снова просочилось произвольное число: 17 и 18
  // рядом глазом не различить, а вместе они читаются как небрежность.
  const ALLOWED = new Set([14, 16, 18, 20, 24, 32, 40]);
  test.setTimeout(120_000);
  await openApp(page);
  const bad: Glyph[] = [];
  for (const route of ROUTES) {
    await openRoute(page, route);
    bad.push(...(await collectGlyphs(page)).filter((g) => !ALLOWED.has(g.size)));
  }
  expect(bad, `иконки вне шкалы: ${JSON.stringify(bad)}`).toEqual([]);
});

test('иконка не ужимается раскладкой: заданный размер равен фактическому', async ({ page }) => {
  // Тест шкалы ловит только те размеры, которых нет в ALLOWED, — прецедент
  // 18→15 попался именно так, случайно. Сжатие 24→20 или 20→18 он пропустит:
  // оба значения законны. А штрих при этом проседает (24→20 даёт 1.25px вместо
  // 1.5), потому что вес считается от размера.
  //
  // Допуск 0.5px, а не точное равенство: дробная раскладка и кнопки с
  // active:scale-95 дают законные доли пикселя.
  test.setTimeout(120_000);
  await openApp(page);
  const squeezed: Glyph[] = [];
  for (const route of ROUTES) {
    await openRoute(page, route);
    squeezed.push(...(await collectGlyphs(page)).filter((g) => g.asked !== null && g.drift > 0.5));
  }
  expect(squeezed, `иконки ужаты раскладкой: ${JSON.stringify(squeezed)}`).toEqual([]);
});

test('кнопки-иконки в шапке одинаковой ширины на всех экранах', async ({ page }) => {
  // Раньше слот right в Screen набивали шестью разными обёртками (p-1, p-1.5,
  // p-2, size-10, дважды без ничего) — при переходе между разделами правый
  // край шапки заметно прыгал.
  const withHeaderButton = ['/', '/tasks', '/stats', '/more/cycle'];
  await openApp(page);
  const widths: { route: string; w: number }[] = [];
  for (const route of withHeaderButton) {
    await openRoute(page, route);
    const btn = page.locator('header a[aria-label], header button[aria-label]').last();
    await expect(btn, `на ${route} кнопки в шапке нет`).toBeVisible();
    const box = await btn.boundingBox();
    if (box) widths.push({ route, w: Math.round(box.width) });
  }
  expect(widths.length, 'ни одной кнопки в шапке не нашлось').toBeGreaterThanOrEqual(3);
  const uniq = new Set(widths.map((x) => x.w));
  expect([...uniq], `ширины разъехались: ${JSON.stringify(widths)}`).toHaveLength(1);
});

test('один раздел — один рисунок, даже когда он в кадре дважды', async ({ page }) => {
  // Экран поиска и корзина держали СВОЙ список иконок разделов на lucide, а
  // таб-бар под ними рисовал те же разделы уже своими глифами. Один раздел
  // оказывался в кадре двумя разными рисунками одновременно: «Заметки» сверху
  // блокнотом со спиралью, «Заметки» внизу листом с загнутым уголком. Ровно тот
  // шум, ради устранения которого набор и рисовался, только собранный на одном
  // экране вместо разных.
  await openApp(page);

  // Без данных и без запроса на этих экранах нет ни одной иконки раздела —
  // проверять было бы нечего, и тест молча проходил бы всегда.
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.tasks.put({
      ...base('st1'), title: 'фонарь купить', notes: '', projectId: null, goalId: null,
      priority: 0, dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: 0,
    });
    await db.notes.put({
      ...base('sn1'), title: 'фонарь заметка', content: 'фонарь', tags: [], pinned: false,
    });
    // Для корзины — удалённые записи тех же разделов.
    await db.tasks.put({ ...base('st2'), deletedAt: now, title: 'удалённая задача', notes: '',
      projectId: null, goalId: null, priority: 0, dueDate: null, dueTime: null, duration: null,
      remindBefore: null, completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: 0 });
    await db.notes.put({ ...base('sn2'), deletedAt: now, title: 'удалённая заметка',
      content: '', tags: [], pinned: false });
  });

  /** Пара «наш глиф — родная иконка lucide» для одного и того же раздела. */
  const PAIRS: [string, string][] = [
    ['lucide-tasks', 'lucide-list-todo'],
    ['lucide-notes', 'lucide-notebook-text'],
    ['lucide-places', 'lucide-map-pin'],
    ['lucide-learning', 'lucide-graduation-cap'],
    ['lucide-finance', 'lucide-wallet'],
    ['lucide-energy', 'lucide-battery-charging'],
  ];

  const namesOnPage = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('svg.lucide')]
        .map((s) => [...s.classList].find((c) => c.startsWith('lucide-')) ?? '')
        .filter(Boolean),
    );

  await page.goto('/search');
  await expect(page.locator('header h1')).toBeVisible();
  await page.getByPlaceholder(/Искать/i).fill('фонарь');
  await page.waitForTimeout(400);
  let names = await namesOnPage();
  expect(names.length, 'на поиске нет ни одной иконки — проверять нечего').toBeGreaterThan(3);
  for (const [own, theirs] of PAIRS) {
    expect(
      names.includes(own) && names.includes(theirs),
      `на /search раздел нарисован двумя иконками: ${own} и ${theirs}`,
    ).toBe(false);
  }

  await page.goto('/more/trash');
  await expect(page.locator('header h1')).toBeVisible();
  await page.waitForTimeout(400);
  names = await namesOnPage();
  expect(names.length, 'в корзине нет ни одной иконки — проверять нечего').toBeGreaterThan(3);
  for (const [own, theirs] of PAIRS) {
    expect(
      names.includes(own) && names.includes(theirs),
      `в корзине раздел нарисован двумя иконками: ${own} и ${theirs}`,
    ).toBe(false);
  }
});
