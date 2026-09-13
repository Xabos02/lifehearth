import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Перетаскивание в разделе «Задачи».
//
// История: тест переноса месяц лежал как fixme «может, дело в синтетических
// событиях». Дело было в приложении — авто-скролл на 11px/кадр уносил список
// из-под пальца, промах давал null, null молча съедал жест. Починка (заморозка
// цели) открыла свои дыры: позиция продолжала пересчитываться по пустоте,
// свёрнутая цель ловила задачу в невидимую позицию 0, системный обрыв жеста
// коммитил перенос. Эти тесты закрывают и исходный сценарий, и все найденные
// края. Проверки честные: попадание подтверждается подсветкой ДО отпускания,
// скорость меряется в установившемся режиме, а не на подлёте.

async function seed(page: Page, p1Titles: string[] = ['Позвонить поставщику'], p2Titles: string[] = []) {
  await page.evaluate(async ({ p1Titles, p2Titles }) => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null },
      { ...base('p2'), name: 'Здоровье', color: '#3aa35e', emoji: '🏃', sortOrder: 2000, archivedAt: null },
    ]);
    const task = (id: string, title: string, projectId: string, sortOrder: number) => ({
      ...base(id), title, notes: '', projectId, goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder,
    });
    await db.tasks.bulkPut([
      ...p1Titles.map((t, i) => task(`t1_${i}`, t, 'p1', (i + 1) * 1000)),
      ...p2Titles.map((t, i) => task(`t2_${i}`, t, 'p2', (i + 1) * 1000)),
    ]);
  }, { p1Titles, p2Titles });
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Задачи' })).toBeVisible();
}

/** Много задач — чтобы списку было куда прокручиваться при замерах скорости. */
async function seedMany(page: Page, n: number) {
  await seed(page, Array.from({ length: n }, (_, i) => `Задача ${i}`));
}

/** Удержание элемента до старта переноса. Порог 400мс; факт старта
 *  подтверждается плашкой-призраком — без неё «тест прошёл» значил бы лишь
 *  «мышь подвигалась». */
async function hold(page: Page, text: string) {
  const el = page.getByText(text, { exact: true }).first();
  await el.scrollIntoViewIfNeeded();
  await el.hover();
  await page.mouse.down();
  await expect(page.locator('.fixed.z-\\[70\\]'), 'перенос не стартовал — плашки нет').toBeVisible({
    timeout: 2000,
  });
  return el;
}

async function projectOf(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const { db } = await import('/src/db/db.ts');
    return (await db.tasks.get(id))?.projectId ?? null;
  }, id);
}

/** Задачи проекта с порядком и updatedAt — снимок для проверок «ничего не
 *  записано»: sortOrder ловит перестановку, updatedAt — саму запись в базу. */
async function stateOf(page: Page, projectId: string) {
  return page.evaluate(async (projectId) => {
    const { db } = await import('/src/db/db.ts');
    const ts = await db.tasks.toArray();
    return ts
      .filter((t) => t.projectId === projectId && !t.deletedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((t) => ({ id: t.id, sortOrder: t.sortOrder, updatedAt: t.updatedAt }));
  }, projectId);
}

/** Геометрия прокрутки и краевых зон авто-скролла. Верхняя зона отсчитывается
 *  от низа липкой шапки — так делает и приложение. */
async function scrollerBox(page: Page) {
  return page.evaluate(() => {
    const sec = document.querySelector('[data-drop-key]');
    let el = sec?.parentElement ?? null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        const r = el.getBoundingClientRect();
        const header = document.querySelector('header');
        const hb = header ? header.getBoundingClientRect().bottom : r.top;
        return {
          top: r.top,
          bottom: r.bottom,
          scrollTop: el.scrollTop,
          max: el.scrollHeight - el.clientHeight,
          topZoneEnd: hb + 72,
          bottomZoneStart: r.bottom - 72,
        };
      }
      el = el.parentElement;
    }
    return null;
  });
}

/** Навестись на секцию так, чтобы палец в итоге стоял ВНЕ краевых зон
 *  авто-скролла и ВНУТРИ секции. Одного захода мало по двум причинам: точка
 *  в краевой зоне заставляет список ехать, а смена цели двигает линию вставки
 *  (~18px) — вёрстка сдвигается уже ПОСЛЕ наведения, и точка, посчитанная по
 *  старой геометрии, оказывается в зазоре между секциями. Поэтому после
 *  каждого шага прямоугольник перечитывается и попадание проверяется заново. */
async function hoverSection(page: Page, key: string) {
  const target = page.locator(`[data-drop-key="${key}"]`);
  for (let i = 0; i < 12; i++) {
    const z = (await scrollerBox(page))!;
    const box = await target.boundingBox();
    if (!box) break;
    const y = Math.min(Math.max(box.y + 14, z.top + 4), box.y + box.height - 4);
    await page.mouse.move(box.x + box.width / 2, y, { steps: 4 });
    await page.waitForTimeout(120); // сдвиги вёрстки и авто-скролл — дать доехать
    const after = await target.boundingBox();
    const inBand = y > z.topZoneEnd && y < z.bottomZoneStart;
    if (after && inBand && y > after.y + 2 && y < after.y + after.height - 2) break;
  }
  await expect(target, `секция ${key} не подсветилась — попадания не было`).toHaveClass(/ring-accent/);
}

// ---------------------------------------------------------------------------

test('задачу можно перетащить в другой проект — попадание подтверждено до отпускания', async ({ page }) => {
  // Честная версия: палец останавливается НА цели, подсветка проверяется до
  // mouse.up. Прежняя редакция отпускала в точке, откуда список уже уехал, и
  // проходила только за счёт заморозки цели — то есть проверяла не то, что
  // обещала названием.
  await openApp(page, '/tasks');
  await seed(page, [], ['Позвонить поставщику']);
  expect(await projectOf(page, 't2_0')).toBe('p2');

  await hold(page, 'Позвонить поставщику');
  // Цель — p1: он выше зоны разгона, наведение не потревожит список вовсе.
  await hoverSection(page, 'p1');
  await page.mouse.up();

  await expect.poll(() => projectOf(page, 't2_0')).toBe('p1');
});

test('перенос доезжает, даже когда авто-скролл увёз список из-под пальца', async ({ page }) => {
  // Исходный сценарий месячного fixme. Палец наводится на цель (подсветка
  // подтверждена), затем уходит в зону разгона и стоит там, пока список не
  // уедет до упора — под пальцем пустота. Отпускание обязано отдать задачу
  // последней цели, где человек видел подсветку, а не съесть жест.
  await openApp(page, '/tasks');
  await seed(page);
  await hold(page, 'Позвонить поставщику');
  await hoverSection(page, 'p2');

  const z = (await scrollerBox(page))!;
  await page.mouse.move(200, z.bottom - 16, { steps: 8 });
  // Времени с запасом на прокрутку до упора (глубина ~56px → ~8px/кадр).
  await page.waitForTimeout(900);
  const after = (await scrollerBox(page))!;
  // Порог 120, а не 200: после перевода сетки в целые пиксели (шаг 4 вместо
  // 4.25) список стал компактнее, и за те же 900мс авто-скролл увозит ~157px.
  // Проверка здесь — что сценарий вообще воспроизвёлся, а не сколько именно
  // проехало; сам перенос подтверждает строка ниже.
  expect(after.scrollTop, 'список не уехал — сценарий не воспроизвёлся').toBeGreaterThan(120);
  await page.mouse.up();

  await expect.poll(() => projectOf(page, 't1_0')).toBe('p2');
});

test('промах в пустоту сохраняет последнюю прицельную позицию, а не кидает в конец', async ({ page }) => {
  // Дыра первой починки: цель замораживалась, а ПОЗИЦИЯ продолжала считаться
  // по пустоте под пальцем — все середины задач выше, значит «в конец». Жест
  // «прицелился между Второй и Третьей, дёрнул в пустоту, отпустил» уносил
  // задачу в самый низ. Теперь замораживается и позиция.
  await openApp(page, '/tasks');
  await seed(page, ['Первая', 'Вторая', 'Третья']);

  await hold(page, 'Первая');
  // Прицел: верхняя кромка «Третьей» — линия вставки между Второй и Третьей.
  // Итеративно: линия вставки (~18px) сама двигает «Третью» при каждом
  // перенацеливании, поэтому точка, снятая до движения, промахивается. Целимся
  // по свежему прямоугольнику, пока макет не перестанет дышать.
  const third = page.getByText('Третья', { exact: true }).first();
  for (let i = 0; i < 8; i++) {
    const t = (await third.boundingBox())!;
    await page.mouse.move(t.x + 40, t.y + 6, { steps: 3 });
    await page.waitForTimeout(100);
    const settled = (await third.boundingBox())!;
    if (Math.abs(settled.y - t.y) < 3) break;
  }

  // Рывок в пустоту одним скачком — без промежуточных точек, как дёргается
  // настоящий палец. Пустота обязана лежать ВНЕ зон авто-скролла, иначе тест
  // меряет не заморозку, а гонку со скроллом: зазор ПОД секциями на этом
  // сетапе тонет в нижней зоне разгона, список едет, и p2 проезжает под
  // неподвижным пальцем, перехватывая цель. Надёжная пустота — полоса между
  // шапкой и ПЕРВОЙ секцией: там ни секций, ни зон.
  const z = (await scrollerBox(page))!;
  const p1box = (await page.locator('[data-drop-key="p1"]').boundingBox())!;
  const voidY = p1box.y - 8;
  expect(voidY, 'над первой секцией нет полосы вне зоны разгона — сетап не тот').toBeGreaterThan(z.topZoneEnd);
  await page.mouse.move(200, voidY, { steps: 1 });
  await page.waitForTimeout(150);
  await page.mouse.up();

  // Замороженная позиция — между Второй и Третьей. Пересчёт по пустоте дал бы
  // конец списка: [Вторая, Третья, Первая].
  await expect
    .poll(async () => (await stateOf(page, 'p1')).map((t) => t.id))
    .toEqual(['t1_1', 't1_0', 't1_2']);
});

test('скорость авто-скролла нарастает от границы зоны к краю', async ({ page }) => {
  // Замер честный: база снимается ПОСЛЕ подлёта и паузы на установление —
  // прежняя редакция мерила вместе с подлётом, и запас порога был 1.26x
  // вместо заявленных 4x. Двойной замер (граница/край) ловит и возврат
  // постоянной скорости (края сравняются), и потерю рампы.
  test.setTimeout(60_000);
  await openApp(page, '/tasks');
  await seedMany(page, 24);

  await hold(page, 'Задача 0');
  const z0 = (await scrollerBox(page))!;
  expect(z0.max, 'списку некуда прокручиваться — мерить нечего').toBeGreaterThan(600);

  // Глубина ~2px: «едва задел». Установление и замер — по времени, потому что
  // меряется именно скорость за интервал; ждать тут нечего, кроме времени.
  await page.mouse.move(200, z0.bottomZoneStart + 2, { steps: 6 });
  await page.waitForTimeout(250);
  const base1 = (await scrollerBox(page))!.scrollTop;
  await page.waitForTimeout(600);
  const shallow = (await scrollerBox(page))!.scrollTop - base1;
  expect(shallow, 'у границы зоны скролл мёртв — до дальних целей не добраться').toBeGreaterThan(0);
  expect(shallow, `на глубине 2px уехало ${shallow}px за 600мс — снова уносит`).toBeLessThan(150);

  // Глубина ~64px: «прижал к краю». Прежде чем мерить — проверка, что запаса
  // прокрутки хватит и замер не упрётся в конец списка.
  const before = (await scrollerBox(page))!;
  expect(before.max - before.scrollTop, 'запас прокрутки кончился до замера').toBeGreaterThan(500);
  await page.mouse.move(200, before.bottom - 8, { steps: 4 });
  await page.waitForTimeout(150);
  const base2 = (await scrollerBox(page))!.scrollTop;
  await page.waitForTimeout(600);
  const deep = (await scrollerBox(page))!.scrollTop - base2;
  expect(deep, `у края (${deep}px) не быстрее границы (${shallow}px) — рампы нет`).toBeGreaterThan(shallow * 2.5);
  expect(deep, `у края уехало ${deep}px за 600мс — потолок скорости пробит`).toBeLessThanOrEqual(450);
});

test('авто-скролл не включается, пока палец не сдвинулся', async ({ page }) => {
  // Палец лёг на задачу у нижнего края — точка удержания уже в зоне разгона.
  // Без защиты список поехал бы сам, до единого движения пальца, и позиция
  // задачи менялась бы «от воздуха».
  await openApp(page, '/tasks');
  await seedMany(page, 24);

  // Точка удержания: ЦЕНТР строки, попавший в нижнюю краевую зону. Пальцу
  // важен именно центр, куда он и жмёт.
  //
  // Строку в зону ставим САМИ, прокруткой, а не ищем ту, что случайно там
  // оказалась: зона 64px, строка примерно такой же высоты, и попадёт ли
  // чей-нибудь центр в это окно — вопрос вёрстки, а не проверяемого
  // поведения. Стоило уплотнить списки, и тест перестал находить строку,
  // хотя авто-скролл был совершенно исправен.
  // Ждём, пока список станет прокручиваемым: в CI разметка доезжает позже, и
  // разовый замер ловил момент, когда строки уже есть, а прокрутки ещё нет.
  const findPoint = () =>
    page.evaluate(() => {
      const sec = document.querySelector('[data-drop-key]');
      let scroller: HTMLElement | null = (sec?.parentElement as HTMLElement) ?? null;
      while (scroller) {
        const oy = getComputedStyle(scroller).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break;
        scroller = scroller.parentElement;
      }
      if (!scroller) return null;
      const rows = Array.from(document.querySelectorAll('[data-task-id]'));
      const row = rows[Math.floor(rows.length / 2)] as HTMLElement | undefined;
      if (!row) return null;
      // Целимся в середину краевой зоны: нижний край минус её половина.
      const target = scroller.getBoundingClientRect().bottom - 36;
      const r0 = row.getBoundingClientRect();
      scroller.scrollTop += r0.top + r0.height / 2 - target;
      const r = row.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });

  await expect
    .poll(async () => (await findPoint()) !== null, { timeout: 15_000, intervals: [200] })
    .toBe(true);
  const inZone = await findPoint();
  expect(inZone, 'не нашлось строки, которую можно поставить в краевую зону').not.toBeNull();

  // Без hover(): он может доскроллить страницу, а нам нужен палец ровно там,
  // где строка лежит сейчас.
  await page.mouse.move(inZone!.x, inZone!.y);
  await page.mouse.down();
  await expect(page.locator('.fixed.z-\\[70\\]')).toBeVisible({ timeout: 2000 });
  const base = (await scrollerBox(page))!.scrollTop;
  await page.waitForTimeout(700);
  const drift = (await scrollerBox(page))!.scrollTop - base;
  await page.mouse.up();
  expect(drift, `список уехал на ${drift}px без движения пальца`).toBe(0);
});

test('неподвижное удержание с отпусканием не пишет в базу ничего', async ({ page }) => {
  // Позиция ни разу не вычислялась — жест ничего не значит. Ловит и «idx ?? 0»
  // (задача прыгала на первую позицию), и голую перезапись sortOrder без
  // изменений: updatedAt в снимке выдаст любую запись.
  await openApp(page, '/tasks');
  await seed(page, ['Первая', 'Вторая', 'Третья']);
  const before = await stateOf(page, 'p1');

  await hold(page, 'Вторая');
  await page.mouse.up();
  await page.waitForTimeout(350); // записи в Dexie асинхронные — даём им шанс проявиться

  expect(await stateOf(page, 'p1')).toEqual(before);
});

test('отпустить там же, где взял, — порядок и база нетронуты', async ({ page }) => {
  // Палец сдвинулся (жест живой), но вернулся в своё место. Раньше finish
  // переписывал sortOrder ВСЕМ задачам цели даже в этом случае — лишние
  // updatedAt разъезжались синком по устройствам как фантомная перестановка.
  await openApp(page, '/tasks');
  await seed(page, ['Первая', 'Вторая', 'Третья']);
  const before = await stateOf(page, 'p1');

  const el = await hold(page, 'Вторая');
  const box = (await el.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // Дрожание пальца: сдвиг на пару пикселей, заведомо меньше порога
  // перестановки. Прежние 7 пикселей были уже сопоставимы с высотой строки
  // (26 px на этом экране) и на плотной вёрстке переставляли задачу —
  // тест краснел без дефекта. Вернуть палец назад проверку не спасает:
  // после перестановки исходная точка принадлежит уже другой строке.
  await page.mouse.move(cx, cy + 2, { steps: 3 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(350);

  expect(await stateOf(page, 'p1')).toEqual(before);
});

test('свёрнутая секция-цель принимает задачу В КОНЕЦ, а не в невидимое начало', async ({ page }) => {
  // Узел свёрнутой секции жив (заголовок — законная цель), но задачи не
  // отрисованы, и позиция по DOM не считалась — задача падала в 0, поверх
  // ручного порядка, невидимо. «В конец» читается как «добавил в проект».
  await openApp(page, '/tasks');
  await seed(page, ['Новая задача'], ['Раз', 'Два', 'Три']);

  await page.getByText('Здоровье', { exact: true }).first().click();
  await expect(page.getByText('Раз', { exact: true })).toHaveCount(0); // свернулась

  await hold(page, 'Новая задача');
  await hoverSection(page, 'p2');
  await page.mouse.up();

  await expect.poll(() => projectOf(page, 't1_0')).toBe('p2');
  const p2 = await stateOf(page, 'p2');
  expect(p2[p2.length - 1].id, 'задача должна встать последней').toBe('t1_0');
});

test('отпустить задачу чуть выше свёрнутой папки — попадёт в неё, а не в соседа', async ({ page }) => {
  // Между папками 48px зазора, свёрнутая папка — 45px заголовка. Раньше
  // промах в зазор оставлял прежнюю цель: «нужно прям точку искать».
  await openApp(page, '/tasks');
  await seed(page, ['Новая задача'], ['Раз', 'Два', 'Три']);
  await page.getByText('Здоровье', { exact: true }).first().click();
  await expect(page.getByText('Раз', { exact: true })).toHaveCount(0);

  await hold(page, 'Новая задача');
  const p2 = (await page.locator('[data-drop-key="p2"]').boundingBox())!;
  const x = p2.x + p2.width / 2;
  await page.mouse.move(x, p2.y - 5);
  await page.mouse.move(x, p2.y - 10);
  await expect(page.locator('[data-drop-key="p2"]')).toHaveClass(/ring-accent/);
  await page.mouse.up();
  await expect.poll(() => projectOf(page, 't1_0')).toBe('p2');
});

test('проект-цель удалили во время жеста — задача остаётся на месте', async ({ page }) => {
  // Синк пишет в Dexie напрямую и может удалить проект посреди переноса.
  // Раньше отпускание отдавало задаче мёртвый projectId — и она пропадала со
  // всех экранов. Теперь мёртвая цель = жест впустую.
  await openApp(page, '/tasks');
  await seed(page);
  await hold(page, 'Позвонить поставщику');
  await hoverSection(page, 'p2');

  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    await db.projects.update('p2', { deletedAt: new Date().toISOString() });
  });
  await expect(page.locator('[data-drop-key="p2"]')).toHaveCount(0); // секция ушла
  await page.mouse.up();

  await expect.poll(() => projectOf(page, 't1_0')).toBe('p1');
  await expect(page.getByText('Позвонить поставщику')).toBeVisible();
});

// --- Перетаскивание проектов: то, что работало, и обязано работать дальше ---

test('проекты верхнего уровня меняются местами', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);

  await hold(page, 'Здоровье');
  // Тянем выше «Бизнеса» — и НЕ вправо, иначе это будет вложение, а не порядок.
  const biz = (await page.getByText('Бизнес', { exact: true }).first().boundingBox())!;
  await page.mouse.move(20, biz.y - 10, { steps: 12 });
  await page.waitForTimeout(200);
  await page.mouse.up();

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts');
        const ps = await db.projects.toArray();
        return ps.sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.name);
      }),
    )
    .toEqual(['Здоровье', 'Бизнес']);
});

test('обычный тап по заголовку по-прежнему сворачивает секцию', async ({ page }) => {
  // Удержание подавляет клик — но только СВОЙ. Сломай подавление, и секция
  // перестанет сворачиваться вовсе либо начнёт сворачиваться после переноса.
  await openApp(page, '/tasks');
  await seed(page);

  await expect(page.getByText('Позвонить поставщику')).toBeVisible();
  await page.getByText('Бизнес', { exact: true }).first().click();
  await expect(page.getByText('Позвонить поставщику')).toHaveCount(0);
  await page.getByText('Бизнес', { exact: true }).first().click();
  await expect(page.getByText('Позвонить поставщику')).toBeVisible();
});

test('после переноса заголовок не сворачивается сам', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);

  await hold(page, 'Здоровье');
  await page.mouse.move(20, 300, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  // Задача осталась видна: секция «Бизнес» не свернулась от клика, которого
  // человек не делал.
  await expect(page.getByText('Позвонить поставщику')).toBeVisible();
});
