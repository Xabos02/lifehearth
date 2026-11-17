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

/** Подсказки закрыты: их карточки опускают список в нижнюю зону разгона, и
 *  строки начинают ездить сами — замер сдвигов меряет тогда прокрутку. */
const NO_HINTS = { seenHints: ['tasks-quick-add', 'tasks-gestures'] };

/** Подсветка секции-цели — золотое кольцо токена дизайн-системы. Класс
 *  целиком, а не подстрока: «ring-accent» после перехода на lh-токены
 *  перестал встречаться, и проверка краснела на исправной подсветке. */
const DROP_HIGHLIGHT = /(^|\s)ring-lh-accent(\s|$)/;

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
  await expect(target, `секция ${key} не подсветилась — попадания не было`).toHaveClass(DROP_HIGHLIGHT);
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
  //
  // Без подсказок: карточка «Быстрого добавления» опускала список, и «Третья»
  // уходила в нижнюю зону разгона — прицел ехал вместе со списком, хотя
  // сценарий требует точек вне зон (см. про пустоту ниже).
  await openApp(page, '/tasks', NO_HINTS);
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
  await expect(page.locator('[data-drop-key="p2"]')).toHaveClass(DROP_HIGHLIGHT);
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

// --- Дёрганье экрана при переносе (16.11.2026) ------------------------------
//
// Владелец: «когда я перемещаю задачи, мой экран начинает дёргаться». Причин
// нашлось три, у каждой свой страж ниже: линия вставки в потоке сдвигала всё
// ниже себя на 17px на каждом переезде; при отпускании проскакивал кадр со
// старым порядком; зазор между подпроектами перекидывал цель на родителя.
// Всё меряется покадрово (rAF внутри страницы) — глазом и снимками не видно.

type Frame = {
  line: number | null;
  scroll: number;
  rows: Record<string, number>;
  order: string[];
  lit: string[];
  ghost: boolean;
};

/** Начать покадровую запись: линия вставки, строки, прокрутка, подсвеченные
 *  секции, есть ли «призрак». */
async function startFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __rec: boolean };
    w.__frames = [];
    w.__rec = true;
    const sc = document.getElementById('app-scroll');
    const tick = () => {
      if (!w.__rec) return;
      const line = document.querySelector('[data-testid="task-drop-line"]');
      const rows = [...document.querySelectorAll<HTMLElement>('[data-task-id]')];
      w.__frames.push({
        line: line ? line.getBoundingClientRect().top : null,
        scroll: sc?.scrollTop ?? 0,
        rows: Object.fromEntries(rows.map((r) => [r.dataset.taskId!, r.getBoundingClientRect().top])),
        order: rows.map((r) => r.dataset.taskId!),
        lit: [...document.querySelectorAll<HTMLElement>('[data-drop-key]')]
          .filter((s) => /(^|\s)ring-lh-accent(\s|$)/.test(s.className))
          .map((s) => s.dataset.dropKey!),
        ghost: Boolean(document.querySelector('.fixed.z-\\[70\\]')),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopFrames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __rec: boolean };
    w.__rec = false;
    return w.__frames;
  });
}

/** Вести палец по вертикали по 2px с паузой в кадр — так, как ведёт человек:
 *  без паузы десяток движений укладывается в один кадр и промежуточные
 *  положения (зазоры, середины строк) приложение просто не видит. */
async function glide(page: Page, x: number, from: number, to: number) {
  const dir = Math.sign(to - from);
  for (let y = from; dir > 0 ? y < to : y > to; y += 2 * dir) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(16);
  }
}

test('линия вставки переезжает поверх строк — раскладка под пальцем стоит, дрожь у середины её не перекидывает', async ({ page }) => {
  await openApp(page, '/tasks', NO_HINTS);
  await seed(page, ['Задача 0', 'Задача 1', 'Задача 2', 'Задача 3'], ['Купить воду']);
  await hold(page, 'Задача 0');
  const z = (await scrollerBox(page))!;
  const row = (id: string) => page.locator(`[data-task-id="${id}"]`).boundingBox();
  const r0 = (await row('t1_0'))!;
  const r3 = (await row('t1_3'))!;
  const x = r0.x + 60;

  // Проход вниз через все строки, ниже зоны разгона не заходим: прокрутка тут
  // не нужна, и сдвиг вёрстки не спрятался бы за неё.
  await startFrames(page);
  await glide(page, x, r0.y + r0.height / 2, Math.min(r3.y + r3.height - 6, z.bottomZoneStart - 4));
  const pass = await stopFrames(page);
  const linePositions = new Set(pass.map((f) => f.line).filter((v) => v !== null));
  expect(linePositions.size, 'линия не переезжала — сценарий не воспроизвёлся').toBeGreaterThanOrEqual(3);
  // «Поверх строк» — значит видно глазом (PROTOCOL §16.2): линия стоит в DOM
  // раньше строки и без своего z целиком пряталась бы под её фоном.
  const onTop = await page.getByTestId('task-drop-line').evaluate((el) => {
    const r = el.getBoundingClientRect();
    // pointer-events-none прячет линию от hit-test — на замер включаем.
    (el as HTMLElement).style.pointerEvents = 'auto';
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    (el as HTMLElement).style.pointerEvents = '';
    return hit === el;
  });
  expect(onTop, 'линию вставки закрывает строка — индикатора места не видно').toBe(true);
  // Строки (кроме взятой — она сжата scale) стоят: положение в ленте с
  // поправкой на прокрутку не меняется ни на одном кадре. Раньше каждая
  // строка ниже линии прыгала на 17px при каждом её переезде.
  for (const id of ['t1_1', 't1_2', 't1_3', 't2_0']) {
    const ys = pass.map((f) => f.rows[id] + f.scroll);
    expect(Math.max(...ys) - Math.min(...ys), `строка ${id} сдвигалась во время переноса`).toBeLessThan(1);
  }

  // Палец дрожит на ±4px вокруг середины строки: линия остаётся на месте.
  // Люфт раньше давала высота линии в потоке; теперь — DROP_HYSTERESIS.
  const r2 = (await row('t1_2'))!;
  const mid = r2.y + r2.height / 2;
  await glide(page, x, r3.y + r3.height / 2, mid);
  await page.waitForTimeout(100);
  await startFrames(page);
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(x, mid + (i % 2 ? 4 : -4));
    await page.waitForTimeout(32);
  }
  const jitter = await stopFrames(page);
  expect(jitter[0]?.line, 'во время дрожи линии нет вовсе').not.toBeNull();
  expect(new Set(jitter.map((f) => f.line)).size, 'линия мигала между двумя зазорами от дрожи пальца').toBe(1);
  await page.mouse.up();
});

test('отпустил — задача сразу на новом месте, без кадра со старым порядком', async ({ page }) => {
  await openApp(page, '/tasks', NO_HINTS);
  await seed(page, ['Задача 0', 'Задача 1', 'Задача 2']);
  // Запись в базу — с задержкой. В Chromium IndexedDB отвечает почти в тот же
  // кадр, и мигание, видное на iPhone, здесь проскакивало бы незамеченным.
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const table = db.tasks as unknown as { bulkUpdate: (...a: unknown[]) => Promise<unknown> };
    const orig = table.bulkUpdate.bind(table);
    table.bulkUpdate = (...a) => new Promise((r) => setTimeout(r, 400)).then(() => orig(...a));
  });
  await hold(page, 'Задача 0');
  const last = (await page.locator('[data-task-id="t1_2"]').boundingBox())!;
  await glide(page, last.x + 60, last.y - 60, last.y + last.height - 6);
  await expect(page.getByTestId('task-drop-line')).toHaveCount(1);

  await startFrames(page);
  await page.mouse.up();
  await page.waitForTimeout(700);
  const frames = (await stopFrames(page)).filter((f) => !f.ghost);
  expect(frames.length, 'после отпускания не записано ни одного кадра').toBeGreaterThan(5);
  for (const f of frames) {
    expect(f.order, 'кадр со старым порядком после отпускания').toEqual(['t1_1', 't1_2', 't1_0']);
  }
  await expect
    .poll(async () => (await stateOf(page, 'p1')).map((t) => t.id))
    .toEqual(['t1_1', 't1_2', 't1_0']);
});

test('между соседними подпроектами цель не перескакивает на родительскую папку', async ({ page }) => {
  await openApp(page, '/tasks', NO_HINTS);
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.clear();
    await db.tasks.clear();
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null },
      { ...base('s1'), name: 'Поставщики', color: '#e0803a', emoji: '📦', sortOrder: 1100, archivedAt: null, parentId: 'p1' },
      { ...base('s2'), name: 'Реклама', color: '#d94f70', emoji: '📣', sortOrder: 1200, archivedAt: null, parentId: 'p1' },
    ] as never[]);
    const task = (id: string, title: string, projectId: string, sortOrder: number) => ({
      ...base(id), title, notes: '', projectId, goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder,
    });
    await db.tasks.bulkPut([
      task('t1', 'Посчитать маржу', 'p1', 1000),
      task('t2', 'Сверить прайс', 's1', 1000),
      task('t3', 'Запустить рекламу', 's2', 1000),
    ] as never[]);
  });
  await page.goto('/tasks');
  await expect(page.locator('[data-task-id="t3"]')).toBeVisible();

  await hold(page, 'Запустить рекламу');
  const from = (await page.locator('[data-task-id="t3"]').boundingBox())!;
  const to = (await page.locator('[data-task-id="t2"]').boundingBox())!;
  const s1 = (await page.locator('[data-drop-key="s1"]').boundingBox())!;
  const s2 = (await page.locator('[data-drop-key="s2"]').boundingBox())!;
  expect(s2.y - (s1.y + s1.height), 'между подпроектами нет зазора — сценарий не воспроизвёлся').toBeGreaterThan(4);

  await startFrames(page);
  await glide(page, from.x + 60, from.y + from.height / 2, to.y + to.height / 2);
  const frames = await stopFrames(page);
  expect(frames.some((f) => f.lit.includes('s2')) && frames.some((f) => f.lit.includes('s1')), 'цель не сменилась с «Рекламы» на «Поставщиков»').toBe(true);
  // Смена цели не двигает раскладку: подсветка — кольцо, не рамка с отступом
  // (PROTOCOL §6.3), линия — поверх строк. Взятая t3 сжата scale — не в счёт.
  for (const id of ['t1', 't2']) {
    const ys = frames.map((f) => f.rows[id] + f.scroll);
    expect(Math.max(...ys) - Math.min(...ys), `строка ${id} сдвинулась при смене цели`).toBeLessThan(1);
  }
  expect(
    frames.filter((f) => f.lit.includes('p1')).length,
    'в зазоре между подпроектами подсветилась вся папка «Бизнес»',
  ).toBe(0);
  await page.mouse.up();
});
