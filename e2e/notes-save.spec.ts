import type { Page } from '@playwright/test';
import { expect, openApp, test } from './fixtures';

// Сохранение заметки: запись, уход с экрана, перезагрузка обновления.
//
// Аудит 18.11.2026 нашёл здесь самую частую потерю данных у семьи: после
// каждого деплоя первое открытие перезагружало страницу посреди набора (N6),
// уход с экрана без снятия фокуса не сохранял ничего (N2), буква, набранная
// ровно во время записи, считалась сохранённой (N1), а быстрый выход из новой
// заметки возвращал в неё (NEW-N-1) или не удалял её корзиной (N4). Каждый
// тест ниже падает на коде до починки.

type Row = { id: string; content: string; deletedAt: string | null };

async function notes(page: Page): Promise<Row[]> {
  return page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.notes.toArray()).map((n) => ({ id: n.id, content: n.content, deletedAt: n.deletedAt ?? null }));
  });
}

async function startNew(page: Page) {
  await openApp(page, '/notes/new');
  await page.locator('.note-editor').tap();
}

/** Переход внутри приложения, как по ссылке: тогда «назад» истории закрывает
 *  экран, а не выгружает документ. Не через «+» и не через карточку: у обоих
 *  есть удержание, и под нагрузкой WebKit принимал клик за перенос. */
async function spaGo(page: Page, path: string) {
  await page.evaluate((path) => {
    history.pushState(null, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await expect(page.locator('.note-editor')).toBeVisible();
}

async function caretToEnd(page: Page) {
  await page.locator('.note-editor').evaluate((el) => {
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  });
}

async function seedNote(page: Page, content: string): Promise<string> {
  return page.evaluate(async (content) => {
    const { db } = await import('/src/db/db.ts');
    const { create } = await import('/src/db/repo.ts');
    const n = await create(db.notes, { title: '', content, tags: [], pinned: false, folderId: null });
    return n.id;
  }, content);
}

test.describe('быстрый выход из новой заметки', () => {
  // Тап по кнопке снимает фокус раньше клика, уход фокуса начинает запись, и
  // по её окончании экран, которого уже нет, переводил адрес на /notes/<id>.
  test('«Готово» сразу после набора не возвращает в заметку (NEW-N-1)', async ({ page }) => {
    await startNew(page);
    await page.keyboard.type('Готовая', { delay: 30 });
    await page.getByRole('button', { name: 'Готово', exact: true }).tap();
    await expect(page).toHaveURL(/\/notes$/);
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/notes$/);
    expect((await notes(page)).map((n) => n.content)).toEqual(['Готовая']);
  });

  test('«‹ Заметки» сразу после набора не возвращает в заметку (NEW-N-1)', async ({ page }) => {
    await startNew(page);
    await page.keyboard.type('Быстрая', { delay: 30 });
    await page.getByRole('link', { name: 'Назад: Заметки' }).tap();
    await expect(page).toHaveURL(/\/notes$/);
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/notes$/);
    expect((await notes(page)).map((n) => n.content)).toEqual(['Быстрая']);
  });

  test('корзина сразу после набора удаляет заметку, а не открывает снова (N4)', async ({ page }) => {
    await startNew(page);
    await page.keyboard.type('Слово', { delay: 30 });
    await page.getByRole('button', { name: 'Удалить', exact: true }).tap();
    await expect(page).toHaveURL(/\/notes$/);
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/notes$/);
    expect((await notes(page)).filter((n) => !n.deletedAt)).toEqual([]);
  });
});

test.describe('уход с экрана без снятия фокуса (N2)', () => {
  test('«назад» системой сохраняет хвост открытой заметки', async ({ page }) => {
    await openApp(page, '/notes');
    const id = await seedNote(page, 'Покупки к ужину<div>первая строка</div>');
    await spaGo(page, `/notes/${id}`);
    await expect(page.locator('.note-editor')).toContainText('первая строка');
    await caretToEnd(page);
    await page.keyboard.type(' ХВОСТ', { delay: 30 });
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(/\/notes$/);
    await expect.poll(async () => (await notes(page))[0]?.content).toContain('ХВОСТ');
  });

  // Предупреждение скептика: сохранение при уходе без флага «уходим» вернуло
  // бы в заметку при каждом выходе — запись новой заметки переводит адрес.
  test('«назад» системой сохраняет новую заметку и не возвращает в неё', async ({ page }) => {
    await openApp(page, '/notes');
    await spaGo(page, '/notes/new');
    await page.locator('.note-editor').tap();
    await page.keyboard.type('Без паузы', { delay: 30 });
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(/\/notes$/);
    await expect.poll(async () => (await notes(page)).map((n) => n.content)).toEqual(['Без паузы']);
    await page.waitForTimeout(1000);
    await expect(page).toHaveURL(/\/notes$/);
  });

  test('уход приложения в фон сохраняет, не дожидаясь паузы в наборе', async ({ page }) => {
    await openApp(page, '/notes');
    const id = await seedNote(page, 'Фон<div>строка</div>');
    await page.goto(`/notes/${id}`);
    await expect(page.locator('.note-editor')).toContainText('строка');
    // Часы стоят: автосохранение через 0,6 с не наступит, сохранить может
    // только сам уход в фон. Без pauseAt подменные часы идут сами.
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await caretToEnd(page);
    await page.keyboard.type(' в фоне', { delay: 30 });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(async () => (await notes(page))[0]?.content).toContain('в фоне');
  });
});

test('буква, набранная ровно во время записи, тоже сохраняется (N1)', async ({ page }) => {
  await openApp(page, '/notes');
  const id = await seedNote(page, 'Раз<div>два</div>');
  await page.goto(`/notes/${id}`);
  await expect(page.locator('.note-editor')).toContainText('два');
  await caretToEnd(page);
  // В момент, когда автосохранение пишет заметку в IndexedDB, вставляем «!»
  // тем же путём, что и набор. База не замедляется — перехват только видит
  // запись и вставляет букву следующей задачей, пока транзакция идёт.
  await page.evaluate(() => {
    const w = window as unknown as { __arm: boolean; __injected: boolean };
    w.__arm = false;
    w.__injected = false;
    for (const m of ['put', 'add'] as const) {
      const orig = IDBObjectStore.prototype[m];
      IDBObjectStore.prototype[m] = function (this: IDBObjectStore, ...a: Parameters<typeof orig>) {
        if (w.__arm && this.name === 'notes') {
          w.__arm = false;
          setTimeout(() => {
            document.execCommand('insertText', false, '!');
            w.__injected = true;
          }, 0);
        }
        return orig.apply(this, a);
      } as typeof orig;
    }
  });
  await page.keyboard.type(' три', { delay: 60 });
  await page.evaluate(() => {
    (window as unknown as { __arm: boolean }).__arm = true;
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __injected: boolean }).__injected)).toBe(true);
  // Больше ничего не набираем: «!» должен сохраниться сам — по таймеру своей правки.
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Готово', exact: true }).tap();
  await expect(page).toHaveURL(/\/notes$/);
  await expect.poll(async () => (await notes(page)).find((n) => n.id === id)?.content).toContain('три!');
});

test('обновление приложения не перезагружает страницу посреди набора (N6)', async ({ page }) => {
  await openApp(page, '/notes/new');
  // В разработке service worker нет: первую смену контроллера ReloadPrompt
  // считает первой установкой и пропускает, вторая — «приехала новая версия».
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  await page.evaluate(() => {
    (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
  });
  await page.locator('.note-editor').click();
  await page.keyboard.type('Быстрая мысль', { delay: 30 });
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
  await expect(page.locator('.note-editor')).toHaveText('Быстрая мысль');
  // Человек закончил, фокус ушёл: теперь перезагрузка — после сохранения.
  const reloaded = page.waitForEvent('load');
  await page.getByRole('button', { name: 'Готово', exact: true }).tap();
  await reloaded;
  await expect.poll(async () => (await notes(page)).map((n) => n.content)).toEqual(['Быстрая мысль']);
});

test('правка с другого устройства видна и в только что созданной заметке (N7)', async ({ page }) => {
  await startNew(page);
  await page.keyboard.type('Список дел', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Моя строка', { delay: 20 });
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').pop()!;
  // «Сохранено» загорается, только когда записана последняя правка: своя
  // запись в полёте перезаписала бы чужую строку раньше, чем её увидит экран.
  await expect(page.getByText('Сохранено', { exact: true })).toHaveClass(/opacity-100/);
  // Ещё одна своя правка — запись уже обновлением. Своя запись не должна
  // выглядеть чужой: без штампа созданной заметки плашка висела бы на каждой
  // новой заметке.
  await page.keyboard.type('.');
  await expect.poll(async () => (await notes(page))[0]?.content).toContain('Моя строка.');
  await expect(page.getByText('Сохранено', { exact: true })).toHaveClass(/opacity-100/);
  await expect(page.getByText(/Заметку изменили на другом устройстве/)).toHaveCount(0);

  // Так правку с другого устройства кладёт синк: строка с более поздним штампом.
  const remote = (line: string) =>
    page.evaluate(
      async ({ id, line }) => {
        const { db } = await import('/src/db/db.ts');
        const n = (await db.notes.get(id))!;
        await db.notes.put({ ...n, content: `${n.content}<div>${line}</div>`, updatedAt: new Date(Date.now() + 1000).toISOString() });
      },
      { id, line },
    );

  // Курсор в тексте: чужое поверх набираемого не кладём, но о нём говорим.
  await remote('Чужая строка');
  await expect(page.getByText(/Заметку изменили на другом устройстве/)).toBeVisible();

  // Курсор ушёл, несохранённого нет — чужая правка подхватывается молча.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await remote('Вторая чужая');
  await expect(page.locator('.note-editor')).toContainText('Вторая чужая');
  await expect(page.locator('.note-editor')).toContainText('Чужая строка');
});

test('обновление дожидается медленной записи, прежде чем перезагрузить (N6)', async ({ page }) => {
  await openApp(page, '/notes/new');
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  await page.locator('.note-editor').click();
  await page.keyboard.type('Медленная запись', { delay: 30 });
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  // Запись заметки идёт почти секунду: без регистрации «сохрани сейчас»
  // перезагрузка ушла бы раньше, и заметка пропала бы вместе со страницей.
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const slow = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
      (...a: A) => new Promise<R>((done, fail) => setTimeout(() => fn(...a).then(done, fail), 800));
    db.notes.add = slow(db.notes.add.bind(db.notes)) as typeof db.notes.add;
  });
  const reloaded = page.waitForEvent('load');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await reloaded;
  await expect.poll(async () => (await notes(page)).map((n) => n.content)).toEqual(['Медленная запись']);
});

test('«Готово» не закрывает заметку, которая не записалась', async ({ page }) => {
  await openApp(page, '/notes/new');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    db.notes.add = (() => Promise.reject(new Error('нет места'))) as typeof db.notes.add;
  });
  await page.locator('.note-editor').tap();
  await page.keyboard.type('Не теряй меня', { delay: 30 });
  await page.getByRole('button', { name: 'Готово', exact: true }).tap();
  await expect(page.getByText(/Не удалось сохранить заметку/)).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/notes\/new$/);
  await expect(page.locator('.note-editor')).toContainText('Не теряй меня');
});

test('адрес, ставший ссылкой при уходе фокуса, сохраняется ссылкой', async ({ page }) => {
  await startNew(page);
  await page.keyboard.type('Смотреть');
  await page.keyboard.press('Enter');
  await page.keyboard.type('ozon.ru/product/kabel');
  // Автосохранение записало текст, пока он ещё без ссылки («Ozon» — с
  // автозаглавной в начале строки).
  await expect.poll(async () => (await notes(page))[0]?.content ?? '').toContain('zon.ru/product/kabel');
  await expect(page.getByText('Сохранено', { exact: true })).toHaveClass(/opacity-100/);
  await page.locator('.note-editor').evaluate((el: HTMLElement) => el.blur());
  await expect.poll(async () => (await notes(page))[0]?.content).toContain('href="https://ozon.ru/product/kabel"');
});

test('заметка, начатая на адресе удалённой, получает свой адрес', async ({ page }) => {
  // Адрес удалённой или ненайденной заметки — пустой редактор, набор создаёт
  // новую. Её адрес должен смениться на свой: по нему грузятся вложения.
  const gone = '00000000-0000-4000-8000-000000000000';
  await openApp(page, `/notes/${gone}`);
  await page.locator('.note-editor').tap();
  await page.keyboard.type('На чужом адресе', { delay: 30 });
  await expect.poll(async () => (await notes(page)).map((n) => n.content)).toEqual(['На чужом адресе']);
  const id = (await notes(page))[0].id;
  await expect(page).toHaveURL(new RegExp(`/notes/${id}$`));
});
