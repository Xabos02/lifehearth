import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { collectErrors, openApp, test, WORKER_MATCH } from './fixtures';

// Семейные задачи: перенос удержанием и напоминание, поставленное без сети.
//
// Разбор работы 20.09 (задача 26, 862184e) — её проверяли только мышью:
//  - пальцем перенос не работал вовсе. Удержание срабатывало, но стоило
//    повести палец, браузер забирал жест под прокрутку и присылал
//    pointercancel; жест кончался, а все задачи группы переписывались тем же
//    порядком и рассылались участникам;
//  - системный обрыв жеста (звонок, шторка) записывал порядок, в котором
//    строки оказались в тот миг, — как будто задачу отпустили над целью;
//  - долгое нажатие без движения переписывало весь список и следом открывало
//    карточку задачи: флаг «это было удержание» обнулялся раньше клика;
//  - удержание на кружке отметки брало задачу, а отпускание на месте её
//    выполняло — и слало всей семье «Общая задача выполнена»;
//  - отпустил мышь мимо строк — перенос не заканчивался, строка оставалась
//    «поднятой»;
//  - напоминание семейной задачи, поставленное без сети, очередь повторов
//    искала только среди личных задач и молча выбрасывала.
// Палец здесь — настоящие touch-события Chromium через CDP: у page.mouse нет
// прокрутки, которая отбирает жест, — на нём первая беда не видна.

async function seed(page: Page, extra: { sub?: boolean; retry?: string[] } = {}) {
  await page.evaluate(async (extra) => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    const ts = new Date().toISOString();
    await db.family.put({
      id: 'f1', familyId: 'f1', familyToken: 't', familyKey: key, familyName: 'Наши',
      selfMemberId: 'me', lastSeq: 0, lastReadSeq: 0, enabled: true, joinedAt: ts,
      keyEpoch: 0, keyRing: { '0': key },
    } as never);
    await db.familyMembers.bulkPut([
      { id: 'me', familyId: 'f1', seq: 1, displayName: 'Влад', color: '#5b7cfa', joinedAt: ts, leftAt: null, removedAt: null },
      { id: 'p1', familyId: 'f1', seq: 2, displayName: 'Отец', color: '#10b981', joinedAt: ts, leftAt: null, removedAt: null },
    ] as never[]);
    const base = {
      familyId: 'f1', seq: 5, notes: '', priority: 0, dueDate: null, dueTime: null, remindBefore: null,
      color: null, assigneeId: null, createdBy: 'me', completedAt: null, completedBy: null, deletedAt: null,
    };
    await db.familyTasks.bulkPut([
      // Срок далеко впереди: напоминание «за день» не должно оказаться в прошлом.
      { ...base, id: 'a', title: 'Купить хлеб', dueDate: '2099-01-10', remindBefore: 1440, sortOrder: 3000 },
      { ...base, id: 'b', title: 'Позвонить бабушке', sortOrder: 2000 },
      { ...base, id: 'c', title: 'Забрать колёса', sortOrder: 1000 },
    ] as never[]);
    if (extra.sub) {
      localStorage.setItem('life-hub-push-sub', JSON.stringify({ endpoint: 'https://push.example/x' }));
    }
    if (extra.retry) localStorage.setItem('life-hub-reminder-retry', JSON.stringify(extra.retry));
  }, extra);
  await page.goto('/more/family?g=f1&t=tasks');
  await expect(page.getByText('Забрать колёса', { exact: true })).toBeVisible();
}

/** Активные задачи в порядке списка, с их sortOrder. */
async function order(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.familyTasks.toArray())
      .filter((t) => !t.completedAt && !t.deletedAt)
      .sort((a, b) => b.sortOrder - a.sortOrder)
      .map((t) => `${t.title}:${t.sortOrder}`);
  });
}

const rows = (page: Page) => page.locator('[role="button"][aria-label="Изменить задачу"]');
const row = (page: Page, title: string) => rows(page).filter({ hasText: title });

async function center(page: Page, title: string) {
  const box = (await page.getByText(title, { exact: true }).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Палец на вертикали x: touch('touchStart', y) … touch('touchEnd'). */
async function finger(page: Page, x: number) {
  const cdp = await page.context().newCDPSession(page);
  return (type: string, y?: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: y === undefined ? [] : [{ x, y, id: 1 }],
    } as never);
}

const START = ['Купить хлеб:3000', 'Позвонить бабушке:2000', 'Забрать колёса:1000'];

test('перенос пальцем: задача встаёт на новое место', async ({ page }) => {
  const errors = collectErrors(page);
  await openApp(page, '/more/family');
  await seed(page);
  expect(await order(page)).toEqual(START);

  const from = await center(page, 'Забрать колёса');
  const to = await center(page, 'Купить хлеб');
  const touch = await finger(page, from.x);

  await touch('touchStart', from.y);
  // Удержание — время самого жеста, а не ожидание состояния: 400 мс + запас.
  await page.waitForTimeout(600);
  await expect(row(page, 'Забрать колёса'), 'удержание не взяло задачу').toHaveClass(/opacity-70/);
  for (let i = 1; i <= 12; i++) await touch('touchMove', from.y + ((to.y - from.y) * i) / 12);
  await touch('touchEnd');

  // Значения прежние, переставлены: вверх встала перенесённая.
  await expect
    .poll(() => order(page))
    .toEqual(['Забрать колёса:3000', 'Купить хлеб:2000', 'Позвонить бабушке:1000']);
  expect(errors).toEqual([]);
});

test('обрыв жеста системой: порядок остаётся прежним', async ({ page }) => {
  await openApp(page, '/more/family');
  await seed(page);

  const from = await center(page, 'Забрать колёса');
  const to = await center(page, 'Позвонить бабушке');
  const touch = await finger(page, from.x);
  await touch('touchStart', from.y);
  await page.waitForTimeout(600);
  for (let i = 1; i <= 6; i++) await touch('touchMove', from.y + ((to.y - from.y) * i) / 6);
  // Самопроверка: на экране задача уже переехала — обрыву есть что отменять.
  await expect(rows(page).nth(1)).toContainText('Забрать колёса');
  await touch('touchCancel');

  // Строка вернулась на место и не осталась поднятой — и в базе ничего.
  await expect(rows(page).nth(2)).toContainText('Забрать колёса');
  await expect(page.locator('[aria-label="Изменить задачу"].opacity-70')).toHaveCount(0);
  expect(await order(page)).toEqual(START);
});

test('удержание без движения: список не переписан, карточка не открылась', async ({ page }) => {
  await openApp(page, '/more/family');
  await seed(page);

  const at = await center(page, 'Позвонить бабушке');
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.waitForTimeout(600);
  // Самопроверка: удержание действительно сработало, иначе тест пуст.
  await expect(row(page, 'Позвонить бабушке')).toHaveClass(/opacity-70/);
  await page.mouse.up();

  await expect(row(page, 'Позвонить бабушке')).not.toHaveClass(/opacity-70/);
  await expect(page.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);
  expect(await order(page)).toEqual(START);
});

test('удержание на кружке отметки и отпускание на месте задачу не выполняют', async ({ page }) => {
  await openApp(page, '/more/family');
  await seed(page);

  const box = (await row(page, 'Позвонить бабушке').getByRole('button', { name: 'Выполнить' }).boundingBox())!;
  const touch = await finger(page, box.x + box.width / 2);
  await touch('touchStart', box.y + box.height / 2);
  await page.waitForTimeout(600);
  await expect(row(page, 'Позвонить бабушке'), 'удержание не взяло задачу').toHaveClass(/opacity-70/);
  // Отпускание без движения Chromium завершает кликом по кружку.
  await touch('touchEnd');
  await expect(row(page, 'Позвонить бабушке')).not.toHaveClass(/opacity-70/);
  // Отметка пишется в базу не мгновенно — даём ей время случиться, если она есть.
  await page.waitForTimeout(500);

  const done = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.familyTasks.toArray()).filter((t) => t.completedAt).map((t) => t.title);
  });
  expect(done).toEqual([]);
});

test('отпустил мимо списка: перенос закончен, строка не осталась поднятой', async ({ page }) => {
  await openApp(page, '/more/family');
  await seed(page);

  const at = await center(page, 'Купить хлеб');
  const last = await center(page, 'Забрать колёса');
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(row(page, 'Купить хлеб')).toHaveClass(/opacity-70/);
  // Ведём вниз через обе строки и дальше — за край списка.
  await page.mouse.move(at.x, last.y + 200, { steps: 12 });
  await page.mouse.up();

  await expect(page.locator('[aria-label="Изменить задачу"].opacity-70')).toHaveCount(0);
  await expect
    .poll(() => order(page))
    .toEqual(['Позвонить бабушке:3000', 'Забрать колёса:2000', 'Купить хлеб:1000']);
});

test('напоминание семейной задачи, не поставленное без сети, ставится при возвращении', async ({ page }) => {
  const calls: { path: string; taskId?: string }[] = [];
  await openApp(page, '/more/family');
  // Подставной сервер напоминаний. Регистрируется позже заглушки фикстуры —
  // в Playwright побеждает последний обработчик.
  await page.context().route(WORKER_MATCH, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/schedule' || url.pathname === '/cancel') {
      calls.push({ path: url.pathname, taskId: route.request().postDataJSON()?.taskId });
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    await route.abort('failed');
  });
  // Так очередь выглядит после сохранения задачи в метро: запрос упал,
  // id лёг в очередь повторов. Повтор идёт при запуске приложения.
  await seed(page, { sub: true, retry: ['a'] });

  await expect.poll(() => calls.filter((c) => c.path === '/schedule').map((c) => c.taskId)).toContain('a');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('life-hub-reminder-retry')))
    .toBeNull();
});
