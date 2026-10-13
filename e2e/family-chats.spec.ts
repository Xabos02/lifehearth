import { expect } from '@playwright/test';
import { openApp, seedFamilyChats, test } from './fixtures';

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
  // Участники загружены (строка присутствия «Мама · …» над лентой), а имени
  // собеседника над пузырями нет — в личном чате это повтор шапки.
  await expect(page.locator('span.member-color', { hasText: 'Мама' })).toBeVisible();
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
  const asked: string[] = [];
  page.once('dialog', (d) => {
    asked.push(d.message());
    void d.dismiss();
  });
  await page.getByRole('button', { name: 'Пригласить' }).click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toContain('Чат станет общим');
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
