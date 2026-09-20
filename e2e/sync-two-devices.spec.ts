import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { openApp, test, WORKER_MATCH } from './fixtures';
import { makeServer, randomRawKey } from './syncServer';

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
// что показал. Протокол повторён по воркеру: курсор — порядок прихода на
// сервер (seq), last-write-wins по updatedAt.

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

  test('задача, отправленная позже более свежей чужой, всё равно доезжает', async ({ browser }) => {
    // Дефект, из-за которого ночные задачи с телефона не появлялись на маке.
    // Телефон завёл задачу без сети (или свёрнутым) — метка времени старая.
    // Тем временем другое устройство завело свою, и мак её получил: его
    // курсор ушёл вперёд. Потом телефон отправил ту, ночную. По старому
    // курсору «всё новее последней полученной метки» она для мака была
    // старее — и не приходила никогда.
    //
    // Устройств три: своих записей устройство обратно не получает, поэтому
    // курсор мака двигает чужая запись — с планшета. (В прежнем протоколе
    // хватало двух: мак перечитывал и свои, и курсор уезжал на них.)
    const server = makeServer();
    const rawKey = randomRawKey();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    const mac = await device(ctxA, server, rawKey);
    const phone = await device(ctxB, server, rawKey);
    const tablet = await device(ctxC, server, rawKey);

    const makeTask = (page: Page, title: string) =>
      page.evaluate(async (title) => {
        const [{ db }, { create }] = await Promise.all([
          import('/src/db/db.ts'),
          import('/src/db/repo.ts'),
        ]);
        await create(db.tasks, {
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
      }, title);

    // 1. Телефон заводит задачу — и НЕ обменивается (нет сети). Пишем в
    //    базу напрямую, со штампами как у репозитория, но без его отложенной
    //    отправки: иначе через 0,8 с телефон отправил бы её сам, и на
    //    медленной машине она пришла бы на «сервер» раньше планшетной —
    //    сценарий рассыпался бы ещё до проверки.
    await phone.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      const now = new Date().toISOString();
      await db.tasks.put({
        id: crypto.randomUUID(),
        title: 'Ночная задача с телефона',
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
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    });
    // 2. Планшет заводит свою позже и обменивается; мак её получает —
    //    курсор мака уходит вперёд, за ночную.
    await new Promise((r) => setTimeout(r, 20));
    await makeTask(tablet, 'Утренняя задача с планшета');
    await sync(tablet);
    await sync(mac);
    expect(await tasksOf(mac)).toEqual(['Утренняя задача с планшета']);
    // 3. Телефон вышел в сеть: отправил ночную (метка СТАРЕЕ утренней).
    const phoneRound = await sync(phone);
    expect(phoneRound?.pushed, 'телефон не отправил ночную').toBeGreaterThan(0);
    // 4. Мак обменивается снова — и ОБЯЗАН получить ночную.
    const macRound = await sync(mac);
    expect(macRound?.pulled, 'мак не получил ночную задачу').toBeGreaterThan(0);
    expect(await tasksOf(mac)).toEqual(['Ночная задача с телефона', 'Утренняя задача с планшета']);
    await expect(mac.getByText('Ночная задача с телефона')).toBeVisible();

    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
  });

  test('«Перечитать всё заново» возвращает и собственные записи устройства', async ({ browser }) => {
    // Сервер не отдаёт устройству его же записи (они у него есть). Но после
    // восстановления старой копии или аварийного «перечитать всё» их как раз
    // нет — и без смены имени устройства они не вернулись бы никогда.
    const server = makeServer();
    const rawKey = randomRawKey();
    const ctxA = await browser.newContext();
    const mac = await device(ctxA, server, rawKey);

    const id = await mac.evaluate(async () => {
      const [{ db }, { create }] = await Promise.all([
        import('/src/db/db.ts'),
        import('/src/db/repo.ts'),
      ]);
      const row = await create(db.tasks, {
        title: 'Своя задача', notes: '', projectId: null, goalId: null, priority: 0,
        dueDate: null, dueTime: null, duration: null, remindBefore: null, completedAt: null,
        checklist: [], recurrence: null, tags: [], sortOrder: 1000,
      });
      return row.id as string;
    });
    await sync(mac);
    expect(server.rows.size).toBe(1);

    // «Восстановили старую копию»: локально задачи нет, на сервере есть — с
    // именем этого же устройства.
    await mac.evaluate(async (id) => {
      const { db } = await import('/src/db/db.ts');
      await db.tasks.delete(id);
    }, id);
    await sync(mac);
    expect(await tasksOf(mac)).toEqual([]);

    await mac.evaluate(async () => {
      const { requestFullResync } = await import('/src/lib/sync.ts');
      await requestFullResync();
    });
    const r = await sync(mac);
    expect(r?.pulled, 'собственная запись не вернулась').toBeGreaterThan(0);
    expect(await tasksOf(mac)).toEqual(['Своя задача']);

    await ctxA.close();
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

  // Теста «курсор приёма из будущего» больше нет — и самой поломки тоже.
  // Курсор приёма был меткой времени с часов устройства-автора, и одно
  // устройство с убежавшими часами глушило приём у всех остальных. Теперь
  // курсор — порядковый номер, который ставит сервер в момент прихода
  // (migrations/0007); часам устройств до него не дотянуться. Что запись,
  // пришедшая позже более свежей, всё равно доезжает, проверяет тест выше.

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
