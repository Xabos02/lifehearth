import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, openFamilyChrome, test } from './fixtures';

// Недописанное сообщение переживает уход с экрана.
//
// Экран чата размонтируется при переходе на «Участников», при сворачивании
// приложения, при переключении группы. Набранный текст исчезал молча — на
// телефоне это половина сообщения, которую надо набирать заново.

async function seedFamily(page: Page) {
  await page.evaluate(async () => {
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
    await db.familyMessages.bulkPut([
      {
        clientMsgId: 'a1', familyId: 'f1', seq: 1, senderMemberId: 'p1',
        text: 'Заберёшь колёса в субботу?', createdAt: ts, deletedAt: null,
      },
    ] as never[]);
  });
  await page.goto('/more/family?g=f1');
}

const input = (page: Page) => page.getByPlaceholder('Сообщение…');

test('недописанное сообщение возвращается после ухода на другую вкладку', async ({ page }) => {
  await openApp(page, '/more/family');
  await seedFamily(page);

  await input(page).fill('Заберу, но позже — сначала на');
  await openFamilyChrome(page);
  await page.getByRole('button', { name: 'Участники' }).click();
  await expect(input(page)).toHaveCount(0);

  await openFamilyChrome(page);
  await page.getByRole('button', { name: 'Чат' }).click();
  await expect(input(page)).toHaveValue('Заберу, но позже — сначала на');
});

test('отправленное сообщение черновик не оставляет', async ({ page }) => {
  await openApp(page, '/more/family');
  await seedFamily(page);

  await input(page).fill('Готово');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(input(page)).toHaveValue('');

  await openFamilyChrome(page);
  await page.getByRole('button', { name: 'Участники' }).click();
  await openFamilyChrome(page);
  await page.getByRole('button', { name: 'Чат' }).click();
  // Пустое поле, а не «Готово» второй раз.
  await expect(input(page)).toHaveValue('');
});

test('выбранная цитата тоже возвращается', async ({ page }) => {
  await openApp(page, '/more/family');
  await seedFamily(page);

  // Открываем меню сообщения и отвечаем на него.
  await page.getByText('Заберёшь колёса в субботу?').click();
  await page.getByRole('button', { name: 'Ответить' }).click();
  await expect(page.getByText('Заберёшь колёса в субботу?')).toHaveCount(2); // в ленте и в шапке ввода

  await openFamilyChrome(page);
  await page.getByRole('button', { name: 'Участники' }).click();
  await openFamilyChrome(page);
  await page.getByRole('button', { name: 'Чат' }).click();

  // Цитата на месте: сообщение по-прежнему показано дважды.
  await expect(page.getByText('Заберёшь колёса в субботу?')).toHaveCount(2);
});

test('поле ввода растёт под длинный текст', async ({ page }) => {
  await openApp(page, '/more/family');
  await seedFamily(page);

  const one = await input(page).evaluate((el) => el.getBoundingClientRect().height);
  await input(page).fill(
    'Первая строка длинного сообщения\nвторая строка\nтретья строка\nчетвёртая',
  );
  const many = await input(page).evaluate((el) => el.getBoundingClientRect().height);
  expect(many).toBeGreaterThan(one + 20);
});

test('шрифт поля ввода не меньше 16px: иначе iOS увеличивает всю страницу', async ({ page }) => {
  await openApp(page, '/more/family');
  await seedFamily(page);
  const size = await input(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(size).toBeGreaterThanOrEqual(16);
});
