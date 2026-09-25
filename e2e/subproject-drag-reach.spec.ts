import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Вложение подпроекта должно быть достижимо пальцем, а отказ — объяснён.
//
// Владелец: «не могу подпроект прикрепить к проекту, нужно прям точку искать».
// Разбор нашёл три причины, и все три про одно — жест физически выполняется, а
// результата и объяснения нет:
//
// 1. Порог сдвига стоял 40px и отсчитывался от точки нажатия. Заголовок
//    подпроекта начинается на x≈36, значит «вынести наружу» требовало x < 4 —
//    точки, которой на экране нет. Симметрично ломалось вложение при хвате за
//    пустое место справа: кнопка заголовка тянется почти до края.
// 2. Между секциями 48px внешнего отступа, и в прямоугольник секции они не
//    входили: там цель не находилась вовсе, подсказка гасла.
// 3. У проекта, внутри которого уже есть подпроекты, вложение запрещено — но
//    выглядело это как непопадание: подпись оставалась «Поменяет порядок».

const GHOST = '.fixed.z-\\[70\\]';

async function seed(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null, parentId: null },
      { ...base('p2'), name: 'Здоровье', color: '#3aa35e', emoji: '🏃', sortOrder: 2000, archivedAt: null, parentId: null },
      { ...base('p3'), name: 'Поставщики', color: '#f59e0b', emoji: '📦', sortOrder: 1000, archivedAt: null, parentId: 'p1' },
    ] as never[]);
  });
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Задачи' })).toBeVisible();
}

/** Взять заголовок удержанием и дождаться плашки. Точку хвата задаём явно:
 *  именно она и была причиной — от неё отсчитывается сдвиг. */
async function grab(page: Page, name: string, offsetX: number) {
  const el = page.getByText(name, { exact: true }).first();
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  const from = { x: box.x + offsetX, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await expect(page.locator(GHOST), 'перенос не стартовал').toBeVisible({ timeout: 2000 });
  return from;
}

/** Прокрутить ленту так, чтобы точка экрана y встала в середину спокойной
 *  полосы — вне краевых зон авто-скролла (72px от низа ленты и от низа липкой
 *  шапки, как считает приложение), — и вернуть её новую координату.
 *
 *  Без этого тесты гонялись с авто-скроллом. На экране телефона цель лежала
 *  в нижней зоне разгона или вовсе за краем ленты (Здоровье — y≈706 при
 *  низе ленты 584): палец вставал над ней, список начинал ехать, цель
 *  уплывала из-под неподвижного пальца, и подпись «Внутрь …» держалась лишь
 *  несколько кадров. Проверка успевала её поймать или нет — отсюда 20–30%
 *  падений с «Поменяет порядок».
 *
 *  Звать после grab: до старта жеста палец не двигался, авто-скролл заперт
 *  (флаг moved), и прокрутка ничего не пересчитывает. Шапка липкая, а баннер
 *  над ней уезжает с лентой — полоса меняется от самой прокрутки, поэтому
 *  подгоняем в несколько проходов. Палец к точке ведём одним шагом:
 *  промежуточные точки пути могли бы задеть зону разгона. */
async function calmY(page: Page, y: number) {
  return page.evaluate((y) => {
    const sc = document.getElementById('app-scroll')!;
    const band = () => {
      const r = sc.getBoundingClientRect();
      const top = Math.max(r.top, document.querySelector('header')?.getBoundingClientRect().bottom ?? r.top);
      return { top: top + 72, bottom: r.bottom - 72 };
    };
    for (let i = 0; i < 3; i++) {
      const b = band();
      const before = sc.scrollTop;
      sc.scrollTop += y - (b.top + b.bottom) / 2;
      y -= sc.scrollTop - before;
    }
    const b = band();
    if (y < b.top || y > b.bottom) throw new Error(`цель вне спокойной полосы: y=${y}, ${b.top}..${b.bottom}`);
    return y;
  }, y);
}

test('вложение достижимо коротким сдвигом вправо, а не «до края экрана»', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);

  const from = await grab(page, 'Здоровье', 4);
  const biz = (await page.getByText('Бизнес', { exact: true }).first().boundingBox())!;
  // Ведём к «Бизнесу» и вправо ровно на 30px — чуть больше порога, но далеко
  // не «до правого края». Со старым порогом 40 этого не хватало.
  await page.mouse.move(from.x + 30, await calmY(page, biz.y + biz.height / 2));

  await expect(page.locator(GHOST)).toContainText('Внутрь «Бизнес»');
  await page.mouse.up();

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts');
        return (await db.projects.get('p2'))?.parentId ?? null;
      }),
    )
    .toBe('p1');
});

test('цель не теряется в зазоре между папками', async ({ page }) => {
  // Между секциями 48px, и раньше в этой полосе цель не находилась: подсказка
  // сваливалась обратно, будто человек промахнулся.
  await openApp(page, '/tasks');
  await seed(page);

  // Меряем ВО ВРЕМЯ жеста и по самой секции (у неё есть data-drop-key).
  // До жеста мерить нельзя: как только перенос начался, в поток вставляется
  // линия вставки и сдвигает список — край секции уезжает на десятки
  // пикселей, и точка «в зазоре», посчитанная заранее, оказывается мимо.
  const from = await grab(page, 'Здоровье', 4);
  const sec = (await page.locator('[data-drop-key="p1"]').first().boundingBox())!;
  const gapY = await calmY(page, Math.round(sec.y + sec.height + 20));

  await page.mouse.move(from.x + 30, gapY);

  await expect(page.locator(GHOST)).toContainText('Внутрь «Бизнес»');
  await page.mouse.up();
});

test('проект с подпроектом вкладывается в другой — вместе с ним', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);

  // «Бизнес» содержит «Поставщиков». До 11.09.2026 его нельзя было вложить
  // никуда; владелец попросил переносить проект вместе с подпроектами.
  // «Бизнес» (высота 2) внутрь «Здоровья» (глубина 1) — итог три уровня,
  // это предел, и он проходит.
  const from = await grab(page, 'Бизнес', 4);
  const health = (await page.getByText('Здоровье', { exact: true }).first().boundingBox())!;
  await page.mouse.move(from.x + 60, await calmY(page, health.y + health.height / 2));

  await expect(page.locator(GHOST)).toContainText('Внутрь «Здоровье»');
  await page.mouse.up();

  const after = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const p1 = await db.projects.get('p1');
    const p3 = await db.projects.get('p3');
    return { business: p1?.parentId ?? null, suppliers: p3?.parentId ?? null };
  });
  // «Бизнес» уехал внутрь, «Поставщики» остались его подпроектом — уехали следом.
  expect(after).toEqual({ business: 'p2', suppliers: 'p1' });
  // И третий уровень виден на экране.
  await expect(page.getByText('Поставщики')).toBeVisible();
});

test('отказ вложить объяснён словами: глубже трёх уровней не поместится', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);
  // Дорастим «Бизнес» до трёх уровней: Поставщики → Китай. Тогда его высота 3,
  // и внутрь кого бы то ни было он уже не влезает.
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    await db.projects.put({
      id: 'p4', name: 'Китай', color: '#ef4444', emoji: '🇨🇳', sortOrder: 1000, archivedAt: null,
      parentId: 'p3', createdAt: now, updatedAt: now, deletedAt: null,
    } as never);
  });
  await page.goto('/tasks');
  await expect(page.getByText('Китай')).toBeVisible();
  const from = await grab(page, 'Бизнес', 4);
  // Координаты цели — ПОСЛЕ старта жеста: плашка и приглушение источника
  // уже отрисованы, раскладка окончательная.
  const health = (await page.getByText('Здоровье', { exact: true }).first().boundingBox())!;
  await page.mouse.move(from.x + 60, await calmY(page, health.y + health.height / 2));

  await expect(page.locator(GHOST)).toContainText('Глубже трёх уровней');
  await page.mouse.up();

  // И ничего не произошло — отказ честный.
  expect(
    await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      return (await db.projects.get('p1'))?.parentId ?? null;
    }),
  ).toBeNull();
});
