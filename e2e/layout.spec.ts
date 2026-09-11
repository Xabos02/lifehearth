import { test, expect, openApp } from './fixtures';
import type { Page } from '@playwright/test';

// Дефекты вёрстки, которые уже случались и вернутся при любой правке отступов.
// Проверяются геометрией, а не скриншотами: скриншотный тест на этом проекте
// падал бы от смены шрифта, а сказать, что именно сломалось, не мог.

const SCREENS = ['/', './tasks', './notes', './calendar', './home', './more/finance', './more/cycle'];

/** Элементы, вылезшие за правый край экрана. */
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const bad: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // 1px — на округление субпиксельных границ.
      if (r.right > w + 1 || r.left < -1) {
        const cls = (el.className || '').toString().slice(0, 60);
        bad.push(`${el.tagName.toLowerCase()}.${cls} → left=${Math.round(r.left)} right=${Math.round(r.right)} (окно ${w})`);
      }
    }
    return bad.slice(0, 5);
  });
}

for (const path of SCREENS) {
  test(`ничего не вылезает за экран: ${path}`, async ({ page }) => {
    await openApp(page, path);
    await page.waitForTimeout(400);
    expect(await overflowing(page)).toEqual([]);
    // Горизонтальной прокрутки у страницы быть не должно вообще — на телефоне
    // она читается как сломанная вёрстка, а не как возможность.
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(scrollable, `горизонтальный скролл на ${path}`).toBe(false);
  });
}

/** Заполняет ленту так, чтобы ей было куда прокручиваться: пустой экран
 *  проверяет ровно ничего — кнопке нечего перекрывать. */
async function seedLongList(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    const today = new Date().toISOString().slice(0, 10);
    await db.projects.bulkPut([
      { ...base('lp1'), name: 'Дела', color: '#5b7cfa', emoji: '📌', sortOrder: 1000, archivedAt: null },
    ]);
    await db.tasks.bulkPut(
      Array.from({ length: 24 }, (_, i) => ({
        ...base(`lt${i}`),
        title: `Задача с довольно длинным названием номер ${i}`,
        notes: '', projectId: 'lp1', goalId: null, priority: 0,
        dueDate: today, dueTime: null, duration: null, remindBefore: null,
        completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: (i + 1) * 1000,
      })),
    );
    await db.notes.bulkPut(
      Array.from({ length: 12 }, (_, i) => ({
        ...base(`ln${i}`), title: `Заметка ${i}`, content: '<p>Текст заметки для объёма ленты.</p>',
        tags: [], pinned: false, folderId: null,
      })),
    );
    await db.expenseItems.bulkPut(
      Array.from({ length: 14 }, (_, i) => ({
        ...base(`le${i}`), title: `Трата ${i}`, amount: 1000 + i * 137,
        kind: i % 3 === 0 ? 'income' : 'expense', category: 'Дом', date: today, note: '',
      })),
    );
  });
}

// Кнопка «+» — единственный элемент, который живёт ПОВЕРХ ленты, поэтому она
// одна и способна перекрыть содержимое.
//
// История этого теста в двух шагах. В августе кнопка воровала нажатия у того,
// что под неё попадало на «Сегодня»: «отправить» и микрофон строки быстрого
// ввода, крестик подсказки, кружок оценки энергии. Лечили укорачиванием ленты
// на 68px — и тест закреплял «ничего под кнопкой ни на одной позиции
// прокрутки». В сентябре владелец увидел цену: восьмая часть экрана телефона
// стала тёмной пустотой, а строки списка обрезались её краем на полуслове.
//
// Теперь лента идёт до таб-бара, а полоса под кнопку — внутренний отступ.
// Значит проверяем то, что важно человеку: (1) полосы-пустоты нет — низ ленты
// касается таб-бара; (2) в КОНЦЕ прокрутки под кнопкой нет управления —
// последняя строка списка достижима, ради этого отступ и держится; (3) на
// нулевой прокрутке ничего не обрезано краем ленты. Промежуточные перекрытия
// — обычное поведение плавающей кнопки: чтобы нажать то, что под ней, человек
// прокручивает; за это тест больше не краснеет.
for (const route of ['./', './tasks', './notes', './more/finance']) {
  test(`кнопка «+»: полосы-пустоты нет, конец ленты достижим: ${route}`, async ({ page }) => {
    await openApp(page, route);
    await seedLongList(page);
    await page.goto(route);
    await page.waitForTimeout(400);

    const res = await page.evaluate(async () => {
      const sc = document.getElementById('app-scroll');
      const nav = document.querySelector('nav');
      const fab = [...document.querySelectorAll('button')].find((b) => {
        const st = getComputedStyle(b);
        const r = b.getBoundingClientRect();
        return st.position === 'fixed' && r.width >= 44 && r.width === r.height && r.top > innerHeight / 2;
      });
      if (!sc || !fab || !nav) return { fabFound: false, gapToNav: 0, hitsAtEnd: [] as string[], clippedAtTop: [] as string[] };
      const F = fab.getBoundingClientRect();
      const S = sc.getBoundingClientRect();
      const N = nav.getBoundingClientRect();
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const controls = () =>
        [...document.querySelectorAll('button, a, input, select, [role="button"], [role="tab"]')].filter(
          (el) => !el.closest('nav') && el !== fab,
        );

      // (3) нулевая прокрутка: ни один элемент не обрезан нижним краем ленты
      sc.scrollTop = 0;
      await sleep(40);
      const clippedAtTop: string[] = [];
      for (const el of controls()) {
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        // элемент начинается внутри ленты, а кончается ниже её края — обрезан
        if (b.top < S.bottom - 1 && b.bottom > S.bottom + 1 && b.top > S.top) {
          clippedAtTop.push((el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30));
        }
      }

      // (2) конец прокрутки: под кнопкой нет управления
      sc.scrollTop = sc.scrollHeight;
      await sleep(80);
      const hitsAtEnd: string[] = [];
      for (const el of controls()) {
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        const ox = Math.min(b.right, F.right) - Math.max(b.left, F.left);
        const oy = Math.min(b.bottom, F.bottom) - Math.max(b.top, F.top);
        if (ox > 0 && oy > 0) hitsAtEnd.push((el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30));
      }
      sc.scrollTop = 0;
      return { fabFound: true, gapToNav: Math.round(N.top - S.bottom), hitsAtEnd, clippedAtTop };
    });

    expect(res.fabFound, `на ${route} не нашлась кнопка «+»`).toBe(true);
    // (1) полосы-пустоты нет: лента касается таб-бара.
    expect(res.gapToNav, `между лентой и таб-баром пустота на ${route}`).toBeLessThanOrEqual(1);
    // (3) ничего не обрезано краем ленты на старте.
    expect(res.clippedAtTop, `край ленты режет управление на ${route}`).toEqual([]);
    // (2) последняя строка достижима: в конце прокрутки под кнопкой пусто.
    expect(res.hitsAtEnd, `в конце прокрутки кнопка «+» накрыла управление на ${route}`).toEqual([]);
  });
}

test('на экранах без кнопки «+» лента не теряет высоту', async ({ page }) => {
  // Полоса живёт ровно столько, сколько сама кнопка: иначе внизу одиннадцати
  // маршрутов из двадцати висела бы мёртвая пустота высотой почти с таб-бар.
  await openApp(page, './more/settings');
  await page.waitForTimeout(300);
  const strip = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--fab-strip').trim(),
  );
  expect(strip === '' || strip === '0px', `полоса кнопки осталась на экране без кнопки: ${strip}`).toBe(true);
});

test('нижняя панель не наезжает на содержимое', async ({ page }) => {
  await openApp(page, './tasks');
  await page.waitForTimeout(400);
  const overlap = await page.evaluate(() => {
    const nav = [...document.querySelectorAll('nav')].pop();
    if (!nav) return 'панель не найдена';
    const navTop = nav.getBoundingClientRect().top;
    // Прокручиваем до конца: именно в этот момент последний элемент списка
    // раньше уезжал под панель.
    const scroller = document.scrollingElement!;
    scroller.scrollTop = scroller.scrollHeight;
    const hidden = [...document.querySelectorAll('main a, main button')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top < navTop && r.bottom > navTop + 4;
    });
    return hidden.length ? `${hidden.length} элемент(ов) под панелью` : null;
  });
  expect(overlap).toBeNull();
});

test('«Сегодня» показывает задачи дня на первом экране', async ({ page }) => {
  // История: экран открывался по умолчанию и не показывал ни одной задачи —
  // лента 1773px при экране 668px, блок «Задачи на сегодня» начинался на
  // 1400-м пикселе. Место занимало служебное: промо защиты данных 237px,
  // пустой блок напоминаний 155px, подсказка быстрого ввода 243px.
  await openApp(page, './');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.tasks.bulkPut(
      ['Отгрузить заказ', 'Созвон с поставщиком', 'Забрать посылку', 'Пробежка'].map((title, i) => ({
        ...base(`td${i}`), title, notes: '', projectId: null, goalId: null, priority: 0,
        dueDate: today, dueTime: null, duration: null, remindBefore: null,
        completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: (i + 1) * 1000,
      })),
    );
  });
  await page.goto('./');
  await page.waitForTimeout(400);

  const view = await page.evaluate(() => {
    const sc = document.getElementById('app-scroll');
    const rows = [...document.querySelectorAll('[data-task-id]')];
    if (!sc || rows.length === 0) return null;
    const bottom = sc.getBoundingClientRect().bottom;
    // Сколько задач целиком помещается в первый экран, без прокрутки.
    const visible = rows.filter((r) => r.getBoundingClientRect().bottom <= bottom).length;
    return { visible, firstTop: Math.round(rows[0].getBoundingClientRect().top) };
  });

  expect(view, 'на «Сегодня» не нашлось ни одной задачи').not.toBeNull();
  // Три — с запасом на разную высоту строки; до правки было ноль.
  expect(view!.visible, 'задачи дня снова уехали под сгиб').toBeGreaterThanOrEqual(3);
});
