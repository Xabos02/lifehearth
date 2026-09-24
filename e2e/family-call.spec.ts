import { expect } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { openApp, openFamilyChrome, test } from './fixtures';

// Звонок из семейного экрана.
//
// Раньше трубка жила только внутри вкладки «Участники»: чтобы позвонить из
// переписки, надо было уйти со списка сообщений, найти человека и вернуться.
// Теперь она в шапке — то есть доступна и из чата, и из задач.

/** Завести группу с заданными собеседниками (кроме себя). */
async function seedFamily(page: Page, names: string[]) {
  await page.evaluate(async (names) => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    await db.family.put({
      id: 'f1',
      familyId: 'f1',
      familyToken: 't',
      familyKey: key,
      familyName: 'Наши',
      selfMemberId: 'me',
      lastSeq: 0,
      lastReadSeq: 0,
      enabled: true,
      joinedAt: new Date().toISOString(),
      keyEpoch: 0,
      keyRing: { '0': key },
    });
    const mk = (id: string, name: string) => ({
      id,
      familyId: 'f1',
      seq: 1,
      displayName: name,
      color: '#5b7cfa',
      joinedAt: new Date().toISOString(),
      leftAt: null,
      removedAt: null,
    });
    await db.familyMembers.clear();
    await db.familyMembers.bulkPut([
      mk('me', 'Влад'),
      ...names.map((n, i) => mk(`m${i}`, n)),
    ]);
  }, names);
  await page.goto('/more/family?g=f1');
  await expect(page.getByRole('heading', { name: 'Наши' })).toBeVisible();
}

test('в группе из двоих звонок идёт одним тапом, без выбора', async ({ page }) => {
  // Спрашивать «кому?» там, где собеседник ровно один, — лишний экран на
  // ровном месте. Признак прямого звонка — имя прямо в подписи кнопки.
  await openApp(page, '/more/family');
  await seedFamily(page, ['Отец']);
  await expect(page.getByRole('button', { name: 'Позвонить: Отец' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Кому позвонить' })).toHaveCount(0);
});

test('в группе побольше открывается выбор со всеми участниками', async ({ page }) => {
  await openApp(page, '/more/family');
  await seedFamily(page, ['Отец', 'Брат', 'Партнёрша']);
  await page.getByRole('button', { name: 'Позвонить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Кому позвонить' })).toBeVisible();
  for (const name of ['Отец', 'Брат', 'Партнёрша']) {
    await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible();
  }
  // Себя в списке нет — позвонить самому себе нельзя.
  await expect(page.getByRole('button', { name: /Влад/ })).toHaveCount(0);
});

test('звонок доступен ИЗ ЧАТА, а не только со списка участников', async ({ page }) => {
  // Ради этого всё и затевалось: кнопка живёт в шапке, выше вкладок, и не
  // исчезает при переходе на переписку.
  await openApp(page, '/more/family');
  await seedFamily(page, ['Отец', 'Брат']);
  await openFamilyChrome(page);
  await page.getByRole('button', { name: 'Чат' }).click();
  await expect(page.getByRole('button', { name: 'Позвонить', exact: true })).toBeVisible();
});

test('звонить некому — кнопки нет вовсе', async ({ page }) => {
  // Показать трубку, чтобы потом сказать «в группе никого», хуже, чем не
  // показывать её.
  await openApp(page, '/more/family');
  await seedFamily(page, []);
  await expect(page.getByRole('button', { name: /Позвонить/ })).toHaveCount(0);
});

// Без связи с сервером (фикстура обрывает все запросы к нему — ровно то, что
// видит телефон без сети). Найдено сквозным прогоном 13–17.09.
test.describe('без связи с сервером', () => {
  test('звонок сразу говорит «Нет связи с сервером», а не полминуты «Вызов…»', async ({ page }) => {
    // Микрофон разрешён: иначе звонок кончался бы на «Нет доступа к
    // микрофону» и прятал бы то, ради чего тест, — полминуты «Вызов…» и
    // «Не ответили», хотя приглашение не ушло никому.
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => new MediaStream();
    });
    await openApp(page, '/more/family');
    await seedFamily(page, ['Отец']);
    await page.getByRole('button', { name: 'Позвонить: Отец' }).click();
    const reason = page.getByText('Нет связи с сервером', { exact: true });
    await expect(reason).toBeVisible();
    // И в переписке нет «пропущенного звонка»: у Отца ничего не звонило.
    await expect(reason).toBeHidden();
    await expect(page.getByText('Пропущенный аудиозвонок', { exact: false })).toHaveCount(0);
  });

  test('своя зелёная точка — это связь устройства: пропала связь — пропала точка', async ({ page }) => {
    // Точка у себя горела всегда, в том числе без сети, — рядом с «не в сети»
    // в шапке. Здесь сервер сначала есть (подставной), потом пропадает.
    let up = true;
    let server: WebSocketRoute | undefined;
    await page.route(/\/family\/ticket/, (r) => (up ? r.fulfill({ json: { ticket: 't' } }) : r.abort('failed')));
    await page.routeWebSocket(/\/family\/ws/, (ws) => {
      server = ws;
      ws.onMessage((m) => {
        if (JSON.parse(String(m)).type === 'hello') ws.send(JSON.stringify({ type: 'ready', online: ['me'] }));
      });
    });
    await openApp(page, '/more/family');
    await seedFamily(page, ['Отец']);
    await openFamilyChrome(page);
    await page.getByRole('button', { name: 'Участники' }).click();
    const dot = page.getByRole('button', { name: /Влад · вы/ }).getByTestId('presence-dot');
    await expect(dot).toBeVisible();

    up = false;
    await server!.close();
    await expect(dot).toHaveCount(0);
  });
});

test.describe('разбор неудавшегося звонка', () => {
  test('пока неудач не было — экран честно говорит, что показывать нечего', async ({ page }) => {
    await openApp(page, '/more/family');
    await seedFamily(page, ['Отец']);
    await openFamilyChrome(page);
    await page.getByRole('button', { name: 'Участники' }).click();
    await page.getByRole('button', { name: 'Почему звонок не вышел' }).click();
    await expect(page.getByText('Неудачных звонков пока не было.')).toBeVisible();
  });

  test('после обрыва видно причину: ретранслятор, маршруты и вердикт словами', async ({ page }) => {
    await openApp(page, '/more/family');
    await seedFamily(page, ['Отец']);
    // Диагностика — снимок фактов последнего звонка; кладём его так же, как
    // это делает менеджер звонков при обрыве.
    await page.evaluate(() => {
      localStorage.setItem(
        'life-hub-call-diag',
        JSON.stringify({
          at: Date.now(),
          turn: 'http-error',
          turnDetail: 'HTTP 401',
          local: { host: 2, srflx: 1 },
          remote: { host: 1 },
          reason: 'Соединение потеряно',
        }),
      );
    });
    await openFamilyChrome(page);
    await page.getByRole('button', { name: 'Участники' }).click();
    await page.getByRole('button', { name: 'Почему звонок не вышел' }).click();

    await expect(page.getByText('Соединение потеряно')).toBeVisible();
    await expect(page.getByText(/сервер отказал/)).toBeVisible();
    // Без relay-маршрутов вердикт обязан назвать причину человеческим языком.
    await expect(page.getByText(/не получило ретранслятор/)).toBeVisible();
  });
});
