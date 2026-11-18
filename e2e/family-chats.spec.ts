import { expect } from '@playwright/test';
import { openApp, seedFamilyChats, test, answerConfirm } from './fixtures';

// «Семья» — список чатов, как в мессенджере (канва design/family-chats, Б):
// общий чат карточкой вместе с задачами, ниже «Личные» — группы на двоих под
// именем собеседника. Личный чат — настоящая группа со своим ключом, а не
// фильтр общей ленты: у сообщения нет адресата, его читает вся группа.

test.beforeEach(async ({ page }) => {
  await openApp(page, '/more/family');
  await seedFamilyChats(page);
  await page.goto('/more/family');
});

const families = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.family.toArray()).map((c) => c.familyName);
  });

test('список: общий чат с задачами сверху, личные — под именем собеседника', async ({ page }) => {
  await expect(page.getByRole('button', { name: /Наши.*4 участника.*Возьму\. Во сколько выходим/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Общие задачи.*3 активных/ })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Личные' })).toBeVisible();
  // Мама: последнее сообщение и два непрочитанных; название пары в списке не
  // видно — там собеседник.
  await expect(page.getByRole('button', { name: /Мама.*Как ты сегодня\?.*2 непрочитанных/ })).toBeVisible();
  await expect(page.getByText('Влад и Мама')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Аня.*Фото/ })).toBeVisible();
  // Бабушка ещё не вошла — строка честно говорит, что ждём.
  await expect(page.getByRole('button', { name: /Влад и Бабушка.*Ждём, пока войдёт/ })).toBeVisible();
  // Список — не чат: таб-бар на месте.
  await expect(page.getByRole('navigation')).toBeVisible();
});

test('тап по личному чату — переписка с собеседником в шапке, «назад» — снова список', async ({ page }) => {
  await page.getByRole('button', { name: /Мама.*Как ты сегодня/ }).click();
  await expect(page).toHaveURL(/g=p-mom/);
  await expect(page.getByRole('heading', { name: /^Мама/ })).toBeVisible();
  await expect(page.getByText('Возьми ключи от дачи')).toBeVisible();
  // Чат на весь экран — без таб-бара приложения.
  await expect(page.getByRole('navigation')).toHaveCount(0);
  // В шапке — круг собеседника с его буквой.
  await expect(page.locator('header span.rounded-full', { hasText: /^М$/ })).toBeVisible();
  // Имени собеседника над пузырями нет — в личном чате это повтор шапки. Пустой
  // счёт что-то доказывает, только когда сама лента уже знает участников и себя:
  // это видно по статусу, который она отдаёт шапке. Для одного собеседника он
  // «в сети / не в сети / был(а)… / печатает…»; без участников его нет, без
  // своего id собеседников двое и вышло бы «0 в сети». Круг в шапке этого не
  // доказывает — участников шапка грузит сама.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { chatPresence } = await import('/src/features/family/chatPresence.ts');
        const p = chatPresence();
        return p?.familyId === 'p-mom' ? p.text : null;
      }),
    )
    .toMatch(/^(в сети|не в сети|был|печатает)/);
  await expect(page.locator('p.member-color')).toHaveCount(0);
  // Прочитанным чат отмечается через 1,2 с на экране (ChatTab: «открыл и
  // сразу ушёл» — не чтение) — и без сети тоже, отметка локальная.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts');
        return (await db.family.get('p-mom'))?.lastReadSeq;
      }),
    )
    .toBe(3);

  await page.getByRole('link', { name: 'Назад' }).click();
  await expect(page.getByRole('heading', { name: 'Личные' })).toBeVisible();
  // Прочитанное в чате гасит бейдж в списке.
  await expect(page.getByRole('button', { name: /Мама.*непрочитанных/ })).toHaveCount(0);
});

test('в общем чате над репликами видно, кто написал', async ({ page }) => {
  await page.goto('/more/family?g=f1');
  await expect(page.locator('p.member-color', { hasText: 'Папа' })).toBeVisible();
});

/** Подставной сервер: на hello отвечает ready с присутствием — так связь
 *  «на связи», и под названием чата идёт присутствие, а не сбой связи. */
async function serveReady(page: import('@playwright/test').Page, online: string[], lastSeen: Record<string, string> = {}) {
  await page.route(/\/family\/ticket/, (r) => r.fulfill({ json: { ticket: 't' } }));
  await page.routeWebSocket(/\/family\/ws/, (ws) => {
    ws.onMessage((m) => {
      if (JSON.parse(String(m)).type === 'hello') ws.send(JSON.stringify({ type: 'ready', online, lastSeen }));
    });
  });
}
const chatHeader = (page: import('@playwright/test').Page) => page.getByRole('button', { name: /участники и настройки/ });

test('общий чат на двоих: под названием — когда собеседник был в сети, с его именем', async ({ page }) => {
  // Первая группа общая и на двоих («вы и жена»): Папа и Аня вышли.
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    await db.familyMembers.bulkUpdate([
      { key: 'dad', changes: { leftAt: new Date().toISOString() } },
      { key: 'anya', changes: { leftAt: new Date().toISOString() } },
    ]);
  });
  await serveReady(page, ['me'], { mom: new Date(Date.now() - 2 * 3_600_000).toISOString() });
  await page.goto('/more/family?g=f1');
  await expect(chatHeader(page)).toContainText('Мама · был(а) в сети');
  // Без числа участников: «2 участника · Мама · был(а) в сети…» обрезалось бы на 375px.
  await expect(chatHeader(page)).not.toContainText(/\d+ участник/);
});

test('общий чат: «N участников · M в сети» — оба числа с вами', async ({ page }) => {
  // В сети вы и Мама — двое из четырёх, а не «1 в сети».
  await serveReady(page, ['me', 'mom']);
  await page.goto('/more/family?g=f1');
  await expect(chatHeader(page)).toContainText('4 участника · 2 в сети');
});

test('ссылка ?g= из пуша и поиска открывает сразу чат', async ({ page }) => {
  await page.goto('/more/family?g=p-anya');
  await expect(page.getByRole('heading', { name: /^Аня/ })).toBeVisible();
  await expect(page.getByPlaceholder('Сообщение…')).toBeVisible();
});

test('ссылка на группу, которой больше нет, — список с таб-баром; старый ?t=tasks — задачи первой группы', async ({ page }) => {
  await page.goto('/more/family?g=nope');
  await expect(page.getByRole('heading', { name: 'Личные' })).toBeVisible();
  await expect(page).not.toHaveURL(/g=nope/);
  await expect(page.getByRole('navigation')).toBeVisible();

  await page.goto('/more/family?t=tasks');
  await expect(page.getByText('Купить молоко', { exact: true })).toBeVisible();
});

test('карточка группы — по нажатию на название; задачи оттуда и «назад» обратно в карточку', async ({ page }) => {
  await page.getByRole('button', { name: /Наши.*4 участника/ }).click();
  await page.getByRole('button', { name: /^Наши.*участники и настройки/ }).click();
  await expect(page).toHaveURL(/g=f1&t=members/);
  await expect(page.getByRole('button', { name: 'Выйти из группы' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Наши', level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Пригласить' })).toBeVisible();

  await page.getByRole('button', { name: 'Задачи · 3' }).click();
  await expect(page).toHaveURL(/g=f1&t=tasks/);
  await expect(page.getByText('Купить молоко', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Назад' }).click();
  await expect(page).toHaveURL(/g=f1&t=members/);
});

test('пригласить в личный чат можно, но сначала — правда: чат станет общим', async ({ page }) => {
  await page.goto('/more/family?g=p-mom&t=members');
  await expect(page.getByRole('button', { name: 'Выйти из группы' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Мама', level: 1, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Пригласить' }).click();
  expect(await answerConfirm(page, false)).toContain('Чат станет общим');
  // Отказ — приглашения нет.
  await expect(page.getByRole('heading', { name: 'Пригласить в группу' })).toHaveCount(0);
});

test('«Новый личный чат»: есть — открыть, нет — пара и QR; ждём — тот же QR, без второй пары', async ({ page }) => {
  await page.getByRole('button', { name: 'Новый личный чат' }).click();
  await expect(page.getByRole('heading', { name: 'Новый чат' })).toBeVisible();

  await page.getByRole('button', { name: /Папа.*Начать чат/ }).click();
  // Пара создана — человеку остаётся войти по QR и кодовому слову. Название
  // нейтральное: оно открыто лежит в коде приглашения.
  await expect(page.getByRole('heading', { name: 'Пригласить в группу' })).toBeVisible();
  expect(await families(page)).toContain('Личный чат');
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByPlaceholder('Сообщение…')).toBeVisible();

  await page.getByRole('link', { name: 'Назад' }).click();
  await expect(page.getByRole('button', { name: /^Папа.*Ждём, пока войдёт/ })).toBeVisible();

  await page.getByRole('button', { name: 'Новый личный чат' }).click();
  await page.getByRole('button', { name: /Папа.*Показать QR/ }).click();
  await expect(page.getByRole('heading', { name: 'Пригласить в группу' })).toBeVisible();
  expect((await families(page)).filter((n) => n === 'Личный чат')).toHaveLength(1);
  await page.getByRole('button', { name: 'Закрыть' }).click();

  await page.getByRole('link', { name: 'Назад' }).click();
  await page.getByRole('button', { name: 'Новый личный чат' }).click();
  await page.getByRole('button', { name: /Мама.*Чат уже есть/ }).click();
  await expect(page).toHaveURL(/g=p-mom/);
});
