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

/** Личные чаты в базе: id и пометка «заведён как личный». */
const pairFlags = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.family.toArray()).filter((c) => c.familyName === 'Личный чат').map((c) => c.pair ?? false);
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
  await expect(page.getByRole('button', { name: 'Выйти из чата' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Пригласить в личный чат' })).toBeVisible();
  expect(await families(page)).toContain('Личный чат');
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByPlaceholder('Сообщение…')).toBeVisible();
  await expect(page.getByText('Ждём, пока Папа войдёт по приглашению')).toBeVisible();

  await page.getByRole('link', { name: 'Назад' }).click();
  await expect(page.getByRole('button', { name: /^Папа.*Ждём, пока войдёт/ })).toBeVisible();

  await page.getByRole('button', { name: 'Новый личный чат' }).click();
  await page.getByRole('button', { name: /Папа.*Показать QR/ }).click();
  await expect(page.getByRole('heading', { name: 'Пригласить в личный чат' })).toBeVisible();
  expect((await families(page)).filter((n) => n === 'Личный чат')).toHaveLength(1);
  await page.getByRole('button', { name: 'Закрыть' }).click();

  await page.getByRole('link', { name: 'Назад' }).click();
  await page.getByRole('button', { name: 'Новый личный чат' }).click();
  await page.getByRole('button', { name: /Мама.*Чат уже есть/ }).click();
  await expect(page).toHaveURL(/g=p-mom/);
});


// Личный чат с тем, кого нет ни в одной вашей группе: раньше «Новый личный
// чат» предлагал только людей из групп, а без них — «сначала пригласите людей
// в общую группу». Теперь первой строкой — «Пригласить по QR».
test('«Пригласить по QR»: имя — и сразу QR поверх чата; закрыли — чат ждёт собеседника с «Показать QR»', async ({ page }) => {
  await page.getByRole('button', { name: 'Новый личный чат' }).click();
  await page.getByRole('button', { name: /Пригласить по QR/ }).click();
  await expect(page.getByRole('heading', { name: 'Новый личный чат' })).toBeVisible();
  // Своё имя подставлено из общей группы — но его можно поправить.
  await expect(page.getByPlaceholder('Например, Влад')).toHaveValue('Влад');
  const go = page.getByRole('button', { name: 'Показать QR' });
  await expect(go).toBeDisabled();
  await page.getByPlaceholder('Например, Мама').fill('Петя');
  await go.click();

  await expect(page.getByRole('heading', { name: 'Пригласить в личный чат' })).toBeVisible();
  await expect(page.getByAltText('QR-код приглашения')).toBeVisible();
  const word = page.getByText(/^[A-Z2-9]{4} [A-Z2-9]{4}$/);
  await expect(word).toBeVisible();
  expect(await pairFlags(page)).toEqual([true]);
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByRole('heading', { name: 'Пригласить в личный чат' })).toBeHidden();

  // Чат — под именем того, кого позвали, с правдой «ждём» и QR ещё раз.
  await expect(page.getByRole('heading', { name: /^Петя/ })).toBeVisible();
  await expect(page.getByText('Ждём, пока Петя войдёт по приглашению')).toBeVisible();
  // Перезагрузка не открывает QR заново: пометка «открыть приглашение» не
  // живёт в истории дольше одного показа.
  await page.reload();
  await expect(page.getByText('Ждём, пока Петя войдёт по приглашению')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Пригласить в личный чат' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Показать QR' }).click();
  await expect(page.getByRole('heading', { name: 'Пригласить в личный чат' })).toBeVisible();
  // Повторный показ — то же слово: код мог уже уйти собеседнику, и новое
  // слово к нему не подошло бы. Перезагрузка выше память стёрла (слово нигде
  // не хранится) — поэтому сверяем два показа после неё.
  await expect(word).toHaveText(/^[A-Z2-9]{4} [A-Z2-9]{4}$/);
  const again = await word.innerText();
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('button', { name: 'Показать QR' }).click();
  await expect(word).toHaveText(again);
  await page.getByRole('button', { name: 'Закрыть' }).click();

  await page.getByRole('link', { name: 'Назад' }).click();
  await expect(page.getByRole('button', { name: /^Петя.*Ждём, пока войдёт/ })).toBeVisible();

  // Позвать Петю ещё раз — его же чат, а не второй «Петя · Ждём».
  await page.getByRole('button', { name: 'Новый личный чат' }).click();
  await page.getByRole('button', { name: /Пригласить по QR/ }).click();
  await page.getByPlaceholder('Например, Мама').fill('петя ');
  await page.getByRole('button', { name: 'Показать QR' }).click();
  await expect(page.getByRole('heading', { name: 'Пригласить в личный чат' })).toBeVisible();
  expect(await pairFlags(page)).toEqual([true]);
});

test('собеседник вошёл, пока открыт QR, — шторка закрывается сама, и видно, что он в чате', async ({ page }) => {
  await page.goto('/more/family?g=p-wait');
  await page.getByRole('button', { name: 'Показать QR' }).click();
  await expect(page.getByRole('heading', { name: 'Пригласить в личный чат' })).toBeVisible();
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    await db.familyMembers.put({
      id: 'granny', familyId: 'p-wait', seq: 2, displayName: 'Бабушка', color: '#f59e0b',
      joinedAt: new Date().toISOString(), leftAt: null, removedAt: null,
    } as never);
  });
  await expect(page.getByRole('heading', { name: 'Пригласить в личный чат' })).toBeHidden();
  await expect(page.getByText('Бабушка в чате')).toBeVisible();
  await expect(page.getByText(/Ждём, пока/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^Бабушка/ })).toBeVisible();
});

test('новая обычная группа, где пока вы один, — не «ждём собеседника» и не «личный чат»', async ({ page }) => {
  await page.getByRole('button', { name: 'Новый личный чат' }).click();
  await page.getByRole('button', { name: /Новая группа/ }).click();
  await page.getByPlaceholder('Например, «Наша семья»').fill('Дача');
  await page.getByPlaceholder('Например, Влад').fill('Влад');
  await page.getByRole('button', { name: 'Создать группу' }).click();
  await expect(page.getByPlaceholder('Сообщение…')).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Дача/ })).toBeVisible();
  await expect(page.getByText(/Ждём, пока/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Показать QR' })).toHaveCount(0);
  await expect(chatHeader(page)).toContainText('1 участник');

  // И в «Управлении группами» она группа: с названием, которое можно
  // переименовать, и выходом «из группы», а не «из чата с собеседником».
  await page.getByRole('link', { name: 'Назад' }).click();
  await page.getByRole('button', { name: 'Управление группами' }).click();
  const sheet = page.locator('body > div.fixed.inset-0.z-50');
  await expect(sheet.getByRole('button', { name: 'Дача' })).toBeVisible();
  // Наши и Дача — группы; Мама, Аня и Бабушка — чаты.
  await expect(sheet.getByRole('button', { name: 'Выйти из группы' })).toHaveCount(2);
  await expect(sheet.getByRole('button', { name: 'Выйти из чата' })).toHaveCount(3);
});

test('«Управление группами»: личные — под именем собеседника, без «Личный чат» подряд', async ({ page }) => {
  await page.getByRole('button', { name: 'Управление группами' }).click();
  await expect(page.getByRole('heading', { name: 'Управление группами' })).toBeVisible();
  const sheet = page.locator('body > div.fixed.inset-0.z-50');
  await expect(sheet.getByText('Наши', { exact: true })).toBeVisible();
  await expect(sheet.getByText('Мама', { exact: true })).toBeVisible();
  await expect(sheet.getByText('Аня', { exact: true })).toBeVisible();
  await expect(sheet.getByText('Влад и Мама')).toHaveCount(0);
});

test('первый экран «Семьи»: личный чат без всякой группы — и он в «Личных», а не «Группой»', async ({ page }) => {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    await db.family.clear();
    await db.familyMembers.clear();
    await db.familyMessages.clear();
  });
  await page.goto('/more/family');
  await page.getByRole('button', { name: 'Личный чат', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Новый личный чат' })).toBeVisible();
  await page.getByPlaceholder('Например, Мама').fill('Мама');
  // Групп нет — своё имя спросить больше негде.
  const go = page.getByRole('button', { name: 'Показать QR' });
  await expect(go).toBeDisabled();
  await page.getByPlaceholder('Например, Влад').fill('Влад');
  await go.click();

  await expect(page.getByRole('heading', { name: 'Пригласить в личный чат' })).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByText('Ждём, пока Мама войдёт по приглашению')).toBeVisible();

  await page.getByRole('link', { name: 'Назад' }).click();
  await expect(page.getByRole('heading', { name: 'Личные' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Мама.*Ждём, пока войдёт/ })).toBeVisible();
  // Единственный чат — всё равно личный: ни «Группы», ни «Общих задач».
  await expect(page.getByRole('heading', { name: /^Групп/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Общие задачи/ })).toHaveCount(0);
});

test('вошёл по приглашению в личный чат, других чатов нет — он в «Личных», без «ждём» и QR', async ({ page }) => {
  // Приглашение настоящее: та же пара и тот же код, что у пригласившего.
  const { code, word } = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { createFamily, createFamilyInvite } = await import('/src/lib/family/familyLifecycle.ts');
    const id = await createFamily('Личный чат', 'Влад', { pair: true });
    const inv = (await createFamilyInvite(id))!;
    // Этот телефон — у приглашённого: своей копии пары у него нет.
    await db.family.clear();
    await db.familyMembers.clear();
    await db.familyMessages.clear();
    return inv;
  });
  await page.goto('/more/family');
  await page.getByRole('button', { name: 'Войти по приглашению' }).click();
  // Код раньше имени — так бывает всегда, когда сразу наводят камеру: шаг
  // слова открывается, а имя спрашивается при входе.
  await page.getByRole('button', { name: 'Вставить код' }).click();
  await page.getByPlaceholder('Вставьте код приглашения').fill(code);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByText('Приглашение в личный чат')).toBeVisible();
  await page.getByLabel('Кодовое слово').fill(word);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByText('Сначала введите своё имя')).toBeVisible();
  await page.getByPlaceholder('Например, Брат').fill('Мама');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();

  await expect(page.getByPlaceholder('Сообщение…')).toBeVisible();
  expect(await pairFlags(page)).toEqual([true]);
  // Звать ему некого: «ждём» и «Показать QR» — только у пригласившего.
  await expect(page.getByText(/Ждём, пока/)).toHaveCount(0);
  await page.getByRole('link', { name: 'Назад' }).click();
  await expect(page.getByRole('heading', { name: 'Личные' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Групп/ })).toHaveCount(0);
  await expect(page.getByText(/Ждём, пока войдёт/)).toHaveCount(0);
});

test('«Поделиться» отдаёт код с подсказкой в системную шторку; без неё — «Сохранить»', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { shared: string[] };
    w.shared = [];
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (d: { text?: string }) => {
        w.shared.push(d.text ?? '');
      },
    });
  });
  await page.goto('/more/family?g=p-wait');
  await page.getByRole('button', { name: 'Показать QR' }).click();
  await expect(page.getByAltText('QR-код приглашения')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Поделиться', exact: true }).click();
  const sent = await page.evaluate(() => (window as unknown as { shared: string[] }).shared);
  expect(sent).toHaveLength(1);
  // То же, что копирует «Скопировать код»: подсказка, куда вставить, и код,
  // который разбирает экран входа.
  expect(sent[0]).toContain('«Войти по приглашению»');
  const parsed = await page.evaluate(async (text) => {
    const { parsePastedInvite } = await import('/src/lib/crypto.ts');
    return parsePastedInvite(text).kind;
  }, sent[0]);
  expect(parsed).toBe('v3');
});

test('без системной шторки «Поделиться» — на месте «Сохранить»', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }));
  await page.goto('/more/family?g=p-wait');
  await page.getByRole('button', { name: 'Показать QR' }).click();
  await expect(page.getByRole('button', { name: 'Сохранить' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Поделиться', exact: true })).toHaveCount(0);
});

test('карточка личного чата говорит «чат», а не «группа»; у общей — как было', async ({ page }) => {
  // С собеседником: выход — из чата, и вопрос про собеседника.
  await page.goto('/more/family?g=p-mom&t=members');
  await expect(page.getByRole('button', { name: 'Выйти из чата' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Выйти из группы' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Выйти из чата' }).click();
  expect(await answerConfirm(page, false)).toContain('Собеседник об этом не узнает');

  // Заведённый личным (пометка pair), я создатель: переименовывать нечего —
  // название никому не видно; удалить — «чат».
  await page.goto('/more/family?g=p-wait&t=members');
  await expect(page.getByRole('button', { name: /^Удалить чат/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Удалить группу/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Переименовать группу' })).toHaveCount(0);

  // Общая группа — без перемен.
  await page.goto('/more/family?g=f1&t=members');
  await expect(page.getByRole('button', { name: 'Переименовать группу' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Выйти из группы' })).toBeVisible();
});
