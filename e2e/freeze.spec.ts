import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Заморозка задач: шит выбора кандидатов (FreezeSheet) и секция «Заморожено»
// на странице задач.
//
// Диагностика нашла два независимых дефекта, тесты закрывают оба:
//
// 1) Список кандидатов в шите не прокручивался дальше первого экрана. Скролл
//    и клип скруглений карточки сидели на ОДНОМ узле: у .card overflow:hidden
//    — правило вне @layer (index.css), а такие правила по каскаду слоёв
//    перебивают любую Tailwind-утилиту (в т.ч. overflow-y-auto) независимо от
//    порядка классов. Итоговый computed overflow-y всегда оставался hidden, и
//    колесо/палец не двигали scrollTop — человек видел первые ~5 задач из
//    двадцати и не мог добраться до остальных.
//
// 2) Задача архивного проекта в шите попадала в группу «Без проекта», хотя на
//    главном экране такие задачи не видны вовсе (секции строятся только по
//    живым неархивным проектам). Шит обязан быть консистентен с главным
//    экраном: архивный проект — пауза для всех его задач разом, а не смена
//    группы.

/** Корневой узел открытого шита — Sheet.tsx рендерит его порталом в body. */
function sheet(page: Page): Locator {
  return page.locator('.fixed.inset-0.z-50');
}

/** Скролл-контейнер списка кандидатов. Селектор — по двум классам, которые
 *  остаются на нужном узле и в правильной, и в сломанной (объединённой с
 *  .card на одном элементе) версии разметки: один и тот же локатор одинаково
 *  честно проверяет и фикс, и его временный откат при проверке на красноту.
 *  Цвет разделителя в селектор не входит: при переходе на токены lh-*
 *  divide-hairline стал divide-lh-border, и локатор потерял узел, хотя
 *  прокрутка была цела. */
function candidatesScroller(page: Page): Locator {
  return sheet(page).locator('.divide-y.overflow-y-auto');
}

interface SeedProject {
  id: string;
  name: string;
  color?: string;
  emoji?: string;
  sortOrder?: number;
  archivedAt?: string | null;
  parentId?: string | null;
}

interface SeedTask {
  id: string;
  title: string;
  projectId?: string | null;
  sortOrder?: number;
  dueDate?: string | null;
  completedAt?: string | null;
  frozenAt?: string | null;
}

/** Общий сид для всех сценариев файла. В отличие от соседних *.spec.ts (там
 *  форма задач фиксирована под один сценарий), здесь сценарии разные — архив,
 *  уже выполненные/замороженные, просрочка — поэтому проекты и задачи задаются
 *  явными массивами с точечными полями на каждый тест. */
async function seed(page: Page, projects: SeedProject[], tasks: SeedTask[]) {
  await page.evaluate(
    async ({ projects, tasks }) => {
      const { db } = await import('/src/db/db.ts');
      const now = new Date().toISOString();
      await db.projects.clear();
      await db.tasks.clear();
      await db.projects.bulkPut(
        projects.map((p, i) => ({
          id: p.id,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          name: p.name,
          color: p.color ?? '#5b7cfa',
          emoji: p.emoji ?? '💼',
          sortOrder: p.sortOrder ?? (i + 1) * 1000,
          archivedAt: p.archivedAt ?? null,
          parentId: p.parentId ?? null,
        })),
      );
      await db.tasks.bulkPut(
        tasks.map((t, i) => ({
          id: t.id,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          title: t.title,
          notes: '',
          projectId: t.projectId ?? null,
          goalId: null,
          priority: 0,
          dueDate: t.dueDate ?? null,
          dueTime: null,
          duration: null,
          remindBefore: null,
          completedAt: t.completedAt ?? null,
          checklist: [],
          recurrence: null,
          tags: [],
          sortOrder: t.sortOrder ?? (i + 1) * 1000,
          frozenAt: t.frozenAt ?? null,
        })),
      );
    },
    { projects, tasks },
  );
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Задачи' })).toBeVisible();
}

async function openFreezeSheet(page: Page) {
  await page.getByRole('button', { name: 'Заморозить задачи' }).click();
  await expect(page.getByRole('heading', { name: 'Заморозить задачи' })).toBeVisible();
}

// ---------------------------------------------------------------------------

test('до каждого кандидата можно доскроллиться', async ({ page }) => {
  // Единственный тест файла, который целится именно в дефект №1. Обязан
  // падать, если скролл вернуть на один узел с .card (см. проверку на
  // красноту в отчёте по задаче).
  await openApp(page, '/tasks');

  const projects: SeedProject[] = [
    { id: 'p1', name: 'Бизнес', sortOrder: 1000 },
    { id: 'p2', name: 'Здоровье', sortOrder: 2000 },
    { id: 's1', name: 'Поставщики', sortOrder: 1100, parentId: 'p1' }, // подпроект
  ];
  const projectCycle = ['p1', 'p2', 's1'];
  const tasks: SeedTask[] = Array.from({ length: 20 }, (_, i) => ({
    id: `t${i}`,
    title: `Задача ${i}`,
    projectId: projectCycle[i % 3],
    sortOrder: (i + 1) * 1000,
  }));
  await seed(page, projects, tasks);

  await openFreezeSheet(page);
  const scroller = candidatesScroller(page);
  await expect(scroller).toHaveCount(1);

  const overflowY = await scroller.evaluate((el) => getComputedStyle(el).overflowY);
  expect(overflowY, 'overflow-y контейнера обязан быть auto/scroll, а не hidden').toMatch(
    /^(auto|scroll)$/,
  );

  const before = await scroller.evaluate((el) => el.scrollTop);
  await scroller.hover();
  await page.mouse.wheel(0, 400);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop), 'колесо обязано двигать scrollTop контейнера')
    .toBeGreaterThan(before);

  // Докручиваем реальными тиками колеса до конца — так добирается настоящий
  // палец/колесо, а не программная телепортация scrollTop. Без этого можно
  // было бы прокрутить чуть-чуть и решить, что дефекта нет, хотя до последних
  // задач всё равно не добраться.
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, 700);
        return scroller.evaluate((el) => el.scrollTop >= el.scrollHeight - el.clientHeight - 1);
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  // Скоуп на шит: тот же текст есть и в фоновом списке на главном экране
  // (сид активный, поэтому виден и там), без скоупа — неоднозначный локатор.
  await expect(sheet(page).getByText('Задача 19', { exact: true })).toBeVisible();
});

test('выполненные и замороженные не предлагаются', async ({ page }) => {
  // Кандидат — только активная задача. Выполненная и уже замороженная не
  // должны всплывать снова: их и так видно в других местах экрана.
  await openApp(page, '/tasks');
  await seed(
    page,
    [{ id: 'p1', name: 'Бизнес' }],
    [
      { id: 'done', title: 'Готовая задача', projectId: 'p1', completedAt: new Date().toISOString() },
      { id: 'frozen', title: 'Уже замороженная', projectId: 'p1', frozenAt: new Date().toISOString() },
      { id: 'active', title: 'Активная задача', projectId: 'p1' },
    ],
  );

  await openFreezeSheet(page);
  const dlg = sheet(page);
  await expect(dlg.getByText('Активная задача')).toBeVisible();
  await expect(dlg.getByText('Готовая задача')).toHaveCount(0);
  await expect(dlg.getByText('Уже замороженная')).toHaveCount(0);
});

test('задачи архивного проекта не предлагаются и не маскируются под Без проекта', async ({ page }) => {
  // Дефект №2: раньше задача архивного проекта попадала в «Без проекта».
  // Правильно — не показывать её вовсе (как и на главном экране), а «Без
  // проекта» оставить только для задач с настоящим projectId === null.
  await openApp(page, '/tasks');
  await seed(
    page,
    [{ id: 'arch', name: 'Архивный', archivedAt: new Date().toISOString() }],
    [
      { id: 'archTask', title: 'Задача архивного проекта', projectId: 'arch' },
      { id: 'freeTask', title: 'Задача без проекта', projectId: null },
    ],
  );

  await openFreezeSheet(page);
  const dlg = sheet(page);
  await expect(dlg.getByText('Задача архивного проекта')).toHaveCount(0);

  const header = dlg.getByText('Без проекта', { exact: true });
  await expect(header).toBeVisible();
  // Счётчик — соседний span сразу после названия группы: ровно одна задача.
  await expect(header.locator('xpath=following-sibling::span[1]')).toHaveText('1');
  await expect(dlg.getByText('Задача без проекта', { exact: true })).toBeVisible();
});

test('заморозка уводит задачи в секцию Заморожено с подписью проекта', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(
    page,
    [{ id: 'p1', name: 'Бизнес', emoji: '💼' }],
    [
      { id: 't1', title: 'Позвонить в банк', projectId: 'p1' },
      { id: 't2', title: 'Отправить документы', projectId: 'p1' },
    ],
  );

  await openFreezeSheet(page);
  const dlg = sheet(page);
  await dlg.getByText('Позвонить в банк', { exact: true }).click();
  await dlg.getByText('Отправить документы', { exact: true }).click();
  const confirm = dlg.getByRole('button', { name: /Заморозить \(2\)/ });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dlg).toHaveCount(0); // шит закрылся после подтверждения

  const frozenAt = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const [a, b] = await Promise.all([db.tasks.get('t1'), db.tasks.get('t2')]);
    return { t1: a?.frozenAt ?? null, t2: b?.frozenAt ?? null };
  });
  expect(frozenAt.t1, 'frozenAt задачи t1 обязан проставиться').not.toBeNull();
  expect(frozenAt.t2, 'frozenAt задачи t2 обязан проставиться').not.toBeNull();

  const frozenHeading = page.getByRole('heading', { name: 'Заморожено' });
  await expect(frozenHeading).toBeVisible();
  await expect(frozenHeading.locator('xpath=following-sibling::span[1]')).toHaveText('2');

  // В строке замороженной задачи видно имя её проекта. Скоуп — на КОНКРЕТНУЮ
  // строку: обе замороженные задачи из одного проекта, и без такого скоупа
  // «Бизнес» неоднозначно совпадёт с обеими строками сразу.
  const frozenSection = page.locator('section').filter({ has: frozenHeading });
  const row1 = frozenSection.locator('.card > div').filter({ hasText: 'Позвонить в банк' });
  await expect(row1).toBeVisible();
  await expect(row1.getByText(/Бизнес/)).toBeVisible();
});

test('разморозка одной и всех', async ({ page }) => {
  await openApp(page, '/tasks');
  // «Сегодня»/«вчера» спрашиваем у самого приложения (lib/dates.ts), а не
  // считаем в Node: так дата гарантированно совпадает с тем, что вычислит
  // браузер, независимо от часового пояса окружения.
  const { today, yesterday } = await page.evaluate(async () => {
    const { todayKey, addDaysKey } = await import('/src/lib/dates.ts');
    const today = todayKey();
    return { today, yesterday: addDaysKey(today, -1) };
  });
  const ts = new Date().toISOString();
  await seed(
    page,
    [],
    [
      { id: 'a', title: 'Просроченная в заморозке', frozenAt: ts, dueDate: yesterday },
      { id: 'b', title: 'Другая замороженная', frozenAt: ts },
    ],
  );

  const frozenHeading = page.getByRole('heading', { name: 'Заморожено' });
  const frozenSection = page.locator('section').filter({ has: frozenHeading });
  await expect(frozenSection).toBeVisible();

  // Разморозка ОДНОЙ: находим именно её строку и жмём её кнопку-солнце.
  const rowA = frozenSection.locator('.card > div').filter({ hasText: 'Просроченная в заморозке' });
  await rowA.getByRole('button', { name: 'Разморозить задачу' }).click();
  await expect(rowA).toHaveCount(0); // строка ушла из секции

  // Просрочка не всплывает мгновенно: срок, утёкший в прошлое за паузу,
  // переехал на сегодня.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts');
        return (await db.tasks.get('a'))?.dueDate ?? null;
      }),
    )
    .toBe(today);

  await expect(frozenSection.getByText('Другая замороженная')).toBeVisible();

  // Разморозка ВСЕХ: секция обязана исчезнуть из DOM целиком, а не просто
  // опустеть визуально.
  await page.getByRole('button', { name: 'Разморозить всё' }).click();
  await expect(frozenHeading).toHaveCount(0);
});
