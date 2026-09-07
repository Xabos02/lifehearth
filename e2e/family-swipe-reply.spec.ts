import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Свайп вправо по сообщению прикрепляет его как цитату для ответа.
//
// Жест — основной способ ответить на конкретное сообщение: он же описан в
// подсказке «Жесты чата». Если он не срабатывает, остаётся только меню по
// долгому нажатию, о котором ещё надо догадаться.

async function seedChat(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    const ts = new Date().toISOString();
    await db.family.put({
      id: 'f1', familyId: 'f1', familyToken: 't', familyKey: key, familyName: 'Наши',
      selfMemberId: 'me', lastSeq: 2, lastReadSeq: 2, enabled: true, joinedAt: ts,
      keyEpoch: 0, keyRing: { '0': key },
    } as never);
    await db.familyMembers.bulkPut([
      { id: 'me', familyId: 'f1', seq: 1, displayName: 'Влад', color: '#5b7cfa', joinedAt: ts, leftAt: null, removedAt: null },
      { id: 'p1', familyId: 'f1', seq: 2, displayName: 'Отец', color: '#10b981', joinedAt: ts, leftAt: null, removedAt: null },
    ] as never[]);
    await db.familyMessages.bulkPut([
      { clientMsgId: 'm1', familyId: 'f1', seq: 1, senderMemberId: 'p1', text: 'Заберёшь колёса в субботу?', createdAt: ts, deletedAt: null },
    ] as never[]);
  });
  await page.goto('/more/family?g=f1');
  await expect(page.getByText('Заберёшь колёса в субботу?')).toBeVisible();
}

/** Провести по сообщению вправо, как пальцем. */
async function swipeRight(page: Page, text: string, distance = 90) {
  // Берём сам пузырь сообщения, а не текстовый узел внутри: у вложенного
  // элемента другие координаты, и жест уходил мимо.
  const row = page.locator('[data-msg-id]').filter({ hasText: text });
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  const x = box.x + 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Мелкими шагами: жест распознаётся по движению, а не по одному прыжку.
  for (let dx = 10; dx <= distance; dx += 10) {
    await page.mouse.move(x + dx, y);
  }
  await page.mouse.up();
}

test('свайп вправо прикрепляет сообщение как цитату', async ({ page }) => {
  await openApp(page, '/more/family');
  await seedChat(page);

  await swipeRight(page, 'Заберёшь колёса в субботу?');

  // Признак прикреплённой цитаты — кнопка «Отменить ответ» рядом с ней.
  await expect(page.getByRole('button', { name: 'Отменить ответ' })).toBeVisible();
});

test('короткий свайп цитату не ставит — случайное касание не мешает', async ({ page }) => {
  await openApp(page, '/more/family');
  await seedChat(page);

  await swipeRight(page, 'Заберёшь колёса в субботу?', 20);

  await expect(page.getByText('Заберёшь колёса в субботу?')).toHaveCount(1);
});

test('цитата уходит в черновик: вернулся на экран — она на месте', async ({ page }) => {
  await openApp(page, '/more/family');
  await seedChat(page);

  await swipeRight(page, 'Заберёшь колёса в субботу?');
  await expect(page.getByText('Заберёшь колёса в субботу?')).toHaveCount(2);

  await page.getByRole('button', { name: 'Участники' }).click();
  await page.getByRole('button', { name: 'Чат' }).click();

  await expect(page.getByText('Заберёшь колёса в субботу?')).toHaveCount(2);
});

test('свайп срабатывает, даже если палец сперва задержался на сообщении', async ({ page }) => {
  // Так и ведут себя руками: сначала находишь нужное сообщение глазами, палец
  // уже лежит, потом ведёшь вправо. Раньше полсекунды задержки объявляли жест
  // «удержанием», движение игнорировалось, и ответ не прикреплялся — со
  // стороны это выглядит как «свайп не работает».
  await openApp(page, '/more/family');
  await seedChat(page);

  const row = page.locator('[data-msg-id]').filter({ hasText: 'Заберёшь колёса в субботу?' });
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  const x = box.x + 10;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(700); // задержались дольше долгого нажатия
  for (let dx = 10; dx <= 90; dx += 10) await page.mouse.move(x + dx, y);
  await page.mouse.up();

  await expect(page.getByRole('button', { name: 'Отменить ответ' })).toBeVisible();
});

test('удержание без движения по-прежнему открывает меню', async ({ page }) => {
  await openApp(page, '/more/family');
  await seedChat(page);

  const row = page.locator('[data-msg-id]').filter({ hasText: 'Заберёшь колёса в субботу?' });
  const box = (await row.boundingBox())!;

  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();

  await expect(page.getByRole('button', { name: 'Ответить' })).toBeVisible();
});
