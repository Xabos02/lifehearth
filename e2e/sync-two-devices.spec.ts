import { expect } from '@playwright/test';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { openApp, test, WORKER_MATCH } from './fixtures';

// Обмен данными между ДВУМЯ устройствами — от правки на одном до появления её
// на другом.
//
// Внутренности обмена разобраны юнитами подробно: курсоры, конкурентные
// запуски, ядовитые записи, конфликты уникальных индексов, объём пачек. Целого
// круга при этом не проверял никто: правка → отправка → приём → экран. А
// ломается он именно целиком и молча — фоновый цикл запускается сам и ошибку
// глотает, так что «данные не появляются» приходит от человека, а не от тестов.
//
// Сервер здесь подставной, в памяти теста: настоящий трогать нельзя (там живые
// данные), а проверяется всё равно не он, а клиент — что отправил, что принял,
// что показал. Протокол повторён по воркеру: составной курсор «updatedAt|id»,
// last-write-wins по updatedAt.

interface Rec {
  table: string;
  id: string;
  updatedAt: string;
  deletedAt: string | null;
  ciphertext: string;
}

/** Общий на оба устройства «сервер»: хранит шифротексты и отдаёт дельту. */
function makeServer() {
  const rows = new Map<string, Rec>();
  const keyOf = (r: Rec) => `${r.table}:${r.id}`;
  let pushes = 0;
  let pulls = 0;

  const handle = async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());

    if (url.pathname === '/sync/push') {
      pushes++;
      const body = JSON.parse(req.postData() ?? '{}') as { records?: Rec[] };
      for (const r of body.records ?? []) {
        const prev = rows.get(keyOf(r));
        // Тот же ON CONFLICT, что у воркера: побеждает более свежая правка.
        if (!prev || r.updatedAt > prev.updatedAt) rows.set(keyOf(r), r);
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }

    if (url.pathname === '/sync/pull') {
      pulls++;
      const since = url.searchParams.get('since') ?? '';
      const sep = since.indexOf('|');
      const su = sep >= 0 ? since.slice(0, sep) : since;
      const sid = sep >= 0 ? since.slice(sep + 1) : '';
      const out = [...rows.values()]
        .filter((r) => r.updatedAt > su || (r.updatedAt === su && r.id > sid))
        .sort((a, b) =>
          a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt.localeCompare(b.updatedAt),
        );
      const last = out[out.length - 1];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          records: out,
          hasMore: false,
          nextSince: last ? `${last.updatedAt}|${last.id}` : since,
        }),
      });
    }

    // Всё прочее к воркеру (пуши, семья) тесту не нужно.
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  };

  return {
    handle,
    rows,
    stats: () => ({ pushes, pulls }),
  };
}

/** 32 случайных байта в base64url — сырой ключ аккаунта, общий у устройств. */
function randomRawKey(): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Buffer.from(bytes).toString('base64url');
}

/** Поднять «устройство»: свой профиль браузера, свой IndexedDB, общий сервер. */
async function device(
  ctx: BrowserContext,
  server: ReturnType<typeof makeServer>,
  rawKey: string,
): Promise<Page> {
  // Ловим ТОЛЬКО адрес воркера. Шаблон по '/sync/' цеплял и модули самого
  // приложения — и вместо них уходил 404, отчего оно не поднималось вовсе.
  await ctx.route(WORKER_MATCH, server.handle);
  const page = await ctx.newPage();
  await openApp(page, '/tasks');
  await page.evaluate(async (rawKey) => {
    const [{ db }, { importKeyRaw }] = await Promise.all([
      import('/src/db/db.ts'),
      import('/src/lib/crypto.ts'),
    ]);
    await db.sync.put({
      id: 'config',
      accountId: 'acc-test',
      authToken: 'tok-test',
      key: await importKeyRaw(rawKey),
      enabled: true,
      lastPullAt: '',
      lastPushAt: '',
      lastSyncedAt: '',
      knownTables: [],
    });
  }, rawKey);
  return page;
}

/** Один круг обмена. Возвращает счётчики — по ним видно, что реально уехало. */
async function sync(page: Page) {
  return page.evaluate(async () => {
    const { runSync } = await import('/src/lib/sync.ts');
    return runSync();
  });
}

async function tasksOf(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const rows = await db.tasks.filter((t) => !t.deletedAt).toArray();
    return rows.map((t) => t.title).sort();
  });
}

test.describe('обмен между двумя устройствами', () => {
  test('задача, заведённая на одном, появляется на другом', async ({ browser }) => {
    const server = makeServer();
    const rawKey = randomRawKey();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const mac = await device(ctxA, server, rawKey);
    const phone = await device(ctxB, server, rawKey);

    // На «маке» заводим задачу штатным путём — через репозиторий, как это
    // делает интерфейс: он проставляет sync-штампы, без которых запись не
    // попадёт в окно отправки.
    await mac.evaluate(async () => {
      const [{ db }, { create }] = await Promise.all([
        import('/src/db/db.ts'),
        import('/src/db/repo.ts'),
      ]);
      await create(db.tasks, {
        title: 'Замерить крышку унитаза',
        notes: '',
        projectId: null,
        goalId: null,
        priority: 0,
        dueDate: null,
        dueTime: null,
        duration: null,
        remindBefore: null,
        completedAt: null,
        checklist: [],
        recurrence: null,
        tags: [],
        sortOrder: 1000,
      });
    });

    const sent = await sync(mac);
    expect(sent?.pushed, 'мак ничего не отправил').toBeGreaterThan(0);

    const got = await sync(phone);
    expect(got?.pulled, 'телефон ничего не получил').toBeGreaterThan(0);

    expect(await tasksOf(phone)).toContain('Замерить крышку унитаза');
    // И видно на экране, а не только в базе: до перезагрузки, без неё.
    await expect(phone.getByText('Замерить крышку унитаза')).toBeVisible();

    await ctxA.close();
    await ctxB.close();
  });

  test('правка на одном перебивает старую версию на другом', async ({ browser }) => {
    const server = makeServer();
    const rawKey = randomRawKey();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const mac = await device(ctxA, server, rawKey);
    const phone = await device(ctxB, server, rawKey);

    const makeTask = async (page: Page, title: string) =>
      page.evaluate(async (title) => {
        const [{ db }, { create }] = await Promise.all([
          import('/src/db/db.ts'),
          import('/src/db/repo.ts'),
        ]);
        const row = await create(db.tasks, {
          title,
          notes: '',
          projectId: null,
          goalId: null,
          priority: 0,
          dueDate: null,
          dueTime: null,
          duration: null,
          remindBefore: null,
          completedAt: null,
          checklist: [],
          recurrence: null,
          tags: [],
          sortOrder: 1000,
        });
        return row.id as string;
      }, title);

    const id = await makeTask(mac, 'Купить мышку');
    await sync(mac);
    await sync(phone);
    expect(await tasksOf(phone)).toContain('Купить мышку');

    // Переименовали на телефоне — мак обязан узнать.
    await phone.evaluate(async (id) => {
      const [{ db }, { update }] = await Promise.all([
        import('/src/db/db.ts'),
        import('/src/db/repo.ts'),
      ]);
      await update(db.tasks, id, { title: 'Купить хорошую мышку' });
    }, id);
    await sync(phone);
    await sync(mac);

    expect(await tasksOf(mac)).toEqual(['Купить хорошую мышку']);

    await ctxA.close();
    await ctxB.close();
  });

  test('правка догоняет ОТКРЫТУЮ заметку, а не ждёт перезапуска', async ({ browser }) => {
    // Содержимое грузится в редактор один раз: живая привязка перетирала бы
    // текст под руками при автосохранении. Обратная сторона — приехавшая
    // правка не показывалась, пока экран открыт. Владелец описал это так:
    // «добавленное фото в заметки появляется на маке только после перезагрузки
    // приложения».
    const server = makeServer();
    const rawKey = randomRawKey();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const phone = await device(ctxA, server, rawKey);
    const mac = await device(ctxB, server, rawKey);

    const id = await phone.evaluate(async () => {
      const [{ db }, { create }] = await Promise.all([
        import('/src/db/db.ts'),
        import('/src/db/repo.ts'),
      ]);
      const n = await create(db.notes, {
        title: 'Покупки',
        content: '<div>Покупки</div>',
        tags: [],
        pinned: false,
        folderId: null,
      });
      return n.id as string;
    });
    await sync(phone);
    await sync(mac);

    // На маке заметка ОТКРЫТА и человек в неё не печатает.
    await mac.goto(`/notes/${id}`);
    await expect(mac.locator('.note-editor')).toContainText('Покупки');

    // На телефоне дописали и вставили фото.
    await phone.evaluate(async (id) => {
      const [{ db }, { update }] = await Promise.all([
        import('/src/db/db.ts'),
        import('/src/db/repo.ts'),
      ]);
      await update(db.notes, id, {
        content:
          '<div>Покупки</div><div>Молоко</div><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">',
      });
    }, id);
    await sync(phone);
    await sync(mac);

    // Без перезагрузки страницы: и текст, и фото на экране.
    await expect(mac.locator('.note-editor')).toContainText('Молоко');
    await expect(mac.locator('.note-editor img')).toHaveCount(1);

    await ctxA.close();
    await ctxB.close();
  });

  test('пока человек печатает, чужая правка текст не перебивает', async ({ browser }) => {
    // Обратная сторона подхвата: набранное под руками перетирать нельзя ни при
    // каких условиях. Вместо этого — предупреждение.
    const server = makeServer();
    const rawKey = randomRawKey();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const phone = await device(ctxA, server, rawKey);
    const mac = await device(ctxB, server, rawKey);

    const id = await phone.evaluate(async () => {
      const [{ db }, { create }] = await Promise.all([
        import('/src/db/db.ts'),
        import('/src/db/repo.ts'),
      ]);
      const n = await create(db.notes, {
        title: 'Идеи', content: '<div>Идеи</div>', tags: [], pinned: false, folderId: null,
      });
      return n.id as string;
    });
    await sync(phone);
    await sync(mac);

    await mac.goto(`/notes/${id}`);
    await mac.locator('.note-editor').click();
    await mac.keyboard.type(' — моя строка');

    await phone.evaluate(async (id) => {
      const [{ db }, { update }] = await Promise.all([
        import('/src/db/db.ts'),
        import('/src/db/repo.ts'),
      ]);
      await update(db.notes, id, { content: '<div>Идеи</div><div>чужая строка</div>' });
    }, id);
    await sync(phone);
    await sync(mac);

    await expect(mac.locator('.note-editor')).toContainText('моя строка');
    await expect(mac.getByText(/изменили на другом устройстве/)).toBeVisible();

    await ctxA.close();
    await ctxB.close();
  });

  test('курсор приёма из будущего чинится сам, а не глушит приём навсегда', async ({ browser }) => {
    // Курсор приёма приложение берёт НЕ у себя, а с сервера: это метка времени
    // последней полученной записи, а ставит её то устройство, которое запись
    // создало. Одно устройство с убежавшими часами — и курсор всех остальных
    // прыгает в будущее. Дальше сервер честно отвечает «новее ничего нет» на
    // каждый запрос, и устройство НАВСЕГДА перестаёт получать что-либо. Молча:
    // ошибки нет, обмен «успешен», данные просто не приходят.
    const server = makeServer();
    const rawKey = randomRawKey();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const mac = await device(ctxA, server, rawKey);
    const phone = await device(ctxB, server, rawKey);

    await mac.evaluate(async () => {
      const [{ db }, { create }] = await Promise.all([
        import('/src/db/db.ts'),
        import('/src/db/repo.ts'),
      ]);
      await create(db.tasks, {
        title: 'Отправить Кате ноутбук', notes: '', projectId: null, goalId: null, priority: 0,
        dueDate: null, dueTime: null, duration: null, remindBefore: null, completedAt: null,
        checklist: [], recurrence: null, tags: [], sortOrder: 1000,
      });
    });
    await sync(mac);
    // Первый круг телефона — служебный: он записывает набор известных таблиц.
    // Без него срабатывала бы ДРУГАЯ защита (перечитать всё после релиза,
    // добавившего таблицу), она сбрасывала курсор сама, и проверка оказалась
    // бы пустой — мутация это и показала.
    await sync(phone);

    // У телефона курсор уехал на год вперёд.
    await phone.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      const c = await db.sync.get('config');
      const future = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
      await db.sync.put({ ...c, lastPullAt: `${future}|zzz` });
    });

    // Чтобы было что получать: заводим на маке ещё одну задачу уже ПОСЛЕ
    // порчи курсора.
    await mac.evaluate(async () => {
      const [{ db }, { create }] = await Promise.all([
        import('/src/db/db.ts'),
        import('/src/db/repo.ts'),
      ]);
      await create(db.tasks, {
        title: 'Замерить крышку унитаза', notes: '', projectId: null, goalId: null, priority: 0,
        dueDate: null, dueTime: null, duration: null, remindBefore: null, completedAt: null,
        checklist: [], recurrence: null, tags: [], sortOrder: 2000,
      });
    });
    await sync(mac);

    await sync(phone);
    expect(await tasksOf(phone), 'приём молчит из-за курсора в будущем').toContain(
      'Замерить крышку унитаза',
    );

    await ctxA.close();
    await ctxB.close();
  });

  test('курсор отправки из будущего не запирает правки на устройстве', async ({ browser }) => {
    // Зеркальная поломка: часы отъехали НАЗАД, и всё написанное после этого
    // получает штамп «старее» курсора — то есть не попадает в окно отправки
    // никогда. Человек пишет на маке, а на телефоне пусто.
    const server = makeServer();
    const rawKey = randomRawKey();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const mac = await device(ctxA, server, rawKey);
    const phone = await device(ctxB, server, rawKey);

    await mac.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      const c = await db.sync.get('config');
      const future = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
      await db.sync.put({ ...c, lastPushAt: future });
    });
    await mac.evaluate(async () => {
      const [{ db }, { create }] = await Promise.all([
        import('/src/db/db.ts'),
        import('/src/db/repo.ts'),
      ]);
      await create(db.tasks, {
        title: 'Купить тетрадь', notes: '', projectId: null, goalId: null, priority: 0,
        dueDate: null, dueTime: null, duration: null, remindBefore: null, completedAt: null,
        checklist: [], recurrence: null, tags: [], sortOrder: 1000,
      });
    });

    await sync(mac);
    await sync(phone);
    expect(await tasksOf(phone), 'правка заперта курсором отправки').toContain('Купить тетрадь');

    await ctxA.close();
    await ctxB.close();
  });

  test('отказ сервера превращается в понятную причину, а не в молчание', async ({ browser }) => {
    // Фоновый обмен запускается сам и ошибку никому не показывал: приложение
    // могло неделями ничего не возить, а на экране стояла старая дата. Дата
    // без причины тоже мало что даёт — «не удалось» одинаково выглядит и когда
    // нет сети, и когда сервер отвязал устройство, а чинится это по-разному.
    const rawKey = randomRawKey();
    const ctx = await browser.newContext();
    await ctx.route(WORKER_MATCH, (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }),
    );
    const page = await ctx.newPage();
    await openApp(page, '/tasks');
    await page.evaluate(async (rawKey) => {
      const [{ db }, { importKeyRaw }] = await Promise.all([
        import('/src/db/db.ts'),
        import('/src/lib/crypto.ts'),
      ]);
      await db.sync.put({
        id: 'config', accountId: 'acc-test', authToken: 'tok-test',
        key: await importKeyRaw(rawKey), enabled: true,
        lastPullAt: '', lastPushAt: '', lastSyncedAt: '', knownTables: [],
      });
    }, rawKey);

    await page.evaluate(async () => {
      const { runSync } = await import('/src/lib/sync.ts');
      await runSync().catch(() => {});
    });

    const reason = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      const s = await db.settings.get('app');
      return { at: s?.syncFailedAt ?? null, why: s?.syncFailedReason ?? null };
    });
    expect(reason.at, 'неудача не отмечена').not.toBeNull();
    expect(reason.why, 'причина не записана').toContain('подключите его заново');

    // И она видна человеку, а не только в базе.
    await page.goto('/more/settings');
    await expect(page.getByText(/Последняя попытка не удалась/)).toContainText(
      'подключите его заново',
    );

    await ctx.close();
  });

  test('удаление уезжает пометкой, а не молчанием', async ({ browser }) => {
    // Отсутствие записи по сети не передать: сервер возит пометку об удалении.
    // Сломай это — и удалённая на одном устройстве задача воскресала бы на
    // другом при следующем круге.
    const server = makeServer();
    const rawKey = randomRawKey();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const mac = await device(ctxA, server, rawKey);
    const phone = await device(ctxB, server, rawKey);

    const id = await mac.evaluate(async () => {
      const [{ db }, { create }] = await Promise.all([
        import('/src/db/db.ts'),
        import('/src/db/repo.ts'),
      ]);
      const row = await create(db.tasks, {
        title: 'Снять деньги',
        notes: '',
        projectId: null,
        goalId: null,
        priority: 0,
        dueDate: null,
        dueTime: null,
        duration: null,
        remindBefore: null,
        completedAt: null,
        checklist: [],
        recurrence: null,
        tags: [],
        sortOrder: 1000,
      });
      return row.id as string;
    });
    await sync(mac);
    await sync(phone);
    expect(await tasksOf(phone)).toContain('Снять деньги');

    await mac.evaluate(async (id) => {
      const [{ db }, { remove }] = await Promise.all([
        import('/src/db/db.ts'),
        import('/src/db/repo.ts'),
      ]);
      await remove(db.tasks, id);
    }, id);
    await sync(mac);
    await sync(phone);

    expect(await tasksOf(phone)).not.toContain('Снять деньги');

    await ctxA.close();
    await ctxB.close();
  });
});
