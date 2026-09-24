import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { collectErrors, openApp, test } from './fixtures';

// Общий поиск по приложению.
//
// Экран открывается с главной одним тапом, и раньше он при открытии читал
// девять таблиц целиком — включая всю переписку семьи вместе с фотографиями,
// голосовыми и кусками файлов (они лежат в тех же строках) и все задачи с их
// снимками. Подписки при этом висели живыми: каждое входящее сообщение
// перечитывало всё заново.

async function seed(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const ts = new Date().toISOString();
    // Задачи с фотографиями: снимки лежат прямо в строке задачи, и полное
    // чтение таблицы поднимает их все. Это и есть тяжесть, которую экран
    // поиска не должен трогать до первого запроса.
    const photo = 'data:image/jpeg;base64,' + 'A'.repeat(120 * 1024);
    await db.tasks.bulkPut([
      { id: 't1', title: 'Забрать колёса', notes: '', done: false, createdAt: ts, updatedAt: ts, deletedAt: null },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `p${i}`, title: `Задача со снимком ${i}`, notes: '', done: false,
        photos: [photo], createdAt: ts, updatedAt: ts, deletedAt: null,
      })),
    ] as never[]);
    await db.notes.put({
      id: 'n1', title: 'Колёса и резина', content: '<p>зимние</p>',
      createdAt: ts, updatedAt: ts, deletedAt: null,
    } as never);

    // Переписка с тяжёлым содержимым: 60 сообщений, каждое десятое — фото.
    const key = await generateKey();
    await db.family.put({
      id: 'f1', familyId: 'f1', familyToken: 'x', familyKey: key, familyName: 'Наши',
      selfMemberId: 'me', lastSeq: 60, lastReadSeq: 60, enabled: true, joinedAt: ts,
      keyEpoch: 0, keyRing: { '0': key },
    } as never);
    await db.familyMessages.bulkPut(
      Array.from({ length: 60 }, (_, i) => ({
        clientMsgId: `m${i}`, familyId: 'f1', seq: i + 1, senderMemberId: 'p1',
        text: i === 7 ? 'Колёса лежат в гараже' : `Сообщение ${i}`,
        createdAt: ts, deletedAt: null,
      })) as never[],
    );
  });
}

/** Считать байты, поднятые из базы. Ставится ДО загрузки страницы: после
 *  перехода на другой экран счётчик в window исчезает вместе со страницей.
 *  Счёт стартует заново на каждой загрузке — то есть меряет ровно тот экран,
 *  который открыли. */
async function countReads(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __read: number };
    w.__read = 0;
    const proto = IDBObjectStore.prototype as unknown as {
      getAll: (...a: unknown[]) => IDBRequest;
    };
    const orig = proto.getAll;
    proto.getAll = function (...args: unknown[]) {
      const req = orig.apply(this, args) as IDBRequest;
      req.addEventListener('success', () => {
        try {
          w.__read += JSON.stringify(req.result ?? '').length;
        } catch {
          /* нестрогая оценка — достаточно порядка величины */
        }
      });
      return req;
    };
  });
}

const readBytes = (page: Page) =>
  page.evaluate(() => (window as unknown as { __read: number }).__read);

test('открытие поиска не поднимает базу — читаем только по запросу', async ({ page }) => {
  await openApp(page, '/');
  await seed(page);

  await countReads(page);
  await page.goto('/search');
  await expect(page.getByPlaceholder('Искать везде…')).toBeVisible();
  await page.waitForTimeout(700);

  // Полное чтение подняло бы почти мегабайт одних снимков задач.
  expect(await readBytes(page)).toBeLessThan(200_000);
});

test('находит по задачам, заметкам и переписке', async ({ page }) => {
  await openApp(page, '/');
  await seed(page);
  await page.goto('/search');

  await page.getByPlaceholder('Искать везде…').fill('колёса');

  await expect(page.getByText('Забрать колёса')).toBeVisible();
  await expect(page.getByText('Колёса и резина')).toBeVisible();
  await expect(page.getByText('Колёса лежат в гараже')).toBeVisible();
});

test('поиск по переписке не различает регистр и «ё» — как внутри чата', async ({ page }) => {
  await openApp(page, '/');
  await seed(page);
  await page.goto('/search');

  await page.getByPlaceholder('Искать везде…').fill('КОЛЕСА');
  await expect(page.getByText('Колёса лежат в гараже')).toBeVisible();
});

test('запрос переживает уход к найденному: «назад» и новый вход из шапки', async ({ page }) => {
  // Прогон 13–17.09: запрос жил только в состоянии экрана и пропадал вместе с
  // ним — после «назад» из найденного поле было пустым.
  //
  // Первая починка писала запрос в адрес (history.replaceState) на каждую
  // букву, а WebKit разрешает не больше 100 таких вызовов за 10 секунд: дальше
  // SecurityError, адрес отставал от поля, и «назад» возвращал обрезанный
  // запрос. Поэтому запрос длиннее сотни букв и набирается посимвольно, без
  // пауз. Этот край ловит только прогон в WebKit
  // (--config=playwright.webkit.config.ts): Chromium лимита не бросает.
  //
  // Второй путь — вкладка «Сегодня» и значок поиска в шапке: у приложения,
  // установленного на экран «Домой», нет кнопки «назад» браузера.
  //
  // Своя задача, а не seed(): там задачи урезаны под поиск (без checklist и
  // прочего), и экран «Задачи», куда ведёт результат, на них падает.
  const errors = collectErrors(page);
  const long = 'колёса '.repeat(22).trim(); // 153 символа
  await openApp(page, '/');
  await page.evaluate(async (notes) => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    await db.tasks.put({
      id: 'w1', title: 'Поменять колёса', notes, projectId: null, goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null, completedAt: null,
      checklist: [], recurrence: null, tags: [], sortOrder: 1000,
      createdAt: ts, updatedAt: ts, deletedAt: null,
    } as never);
  }, long);
  await page.goto('/search');
  const input = page.getByPlaceholder('Искать везде…', { exact: true });
  const hit = page.getByText('Поменять колёса', { exact: true });
  await input.pressSequentially(long);
  await expect(input).toHaveValue(long);
  await hit.click();
  await expect(page).toHaveURL((url) => url.pathname === '/tasks');
  // Экран дорисовался — «назад» уходит с готовой страницы, а не на лету.
  await expect(page.locator('[data-task-id="w1"]')).toBeVisible();

  await page.goBack();
  await expect(input).toHaveValue(long);
  await expect(hit).toBeVisible();

  await page.getByRole('navigation').getByRole('link', { name: 'Сегодня', exact: true }).click();
  await page.getByRole('link', { name: 'Поиск', exact: true }).click();
  await expect(input).toHaveValue(long);
  await expect(hit).toBeVisible();
  expect(errors).toEqual([]);
});

test('по одной букве база не читается', async ({ page }) => {
  await openApp(page, '/');
  await seed(page);
  await countReads(page);
  await page.goto('/search');

  await page.getByPlaceholder('Искать везде…').fill('к');
  await page.waitForTimeout(700);

  expect(await readBytes(page)).toBeLessThan(50_000);
});
