import { test, expect, openApp, WORKER_MATCH } from './fixtures';
import type { Page } from '@playwright/test';

// Исключение прошло, а конверты с новым ключом дошли не до всех. Раньше
// шторка оставалась открытой с красным текстом и той же кнопкой «Исключить»
// (второе нажатие исключало заново и меняло ключ ещё раз), а закрытая шторка
// не оставляла следа: повторить раздачу было неоткуда (аудит 18.11).

const isSend = (u: URL) => WORKER_MATCH.test(u.href) && u.pathname.endsWith('/family/send');
const sendAnswers = (page: Page, status: number) =>
  page.route(isSend, (r) => r.fulfill({ status, contentType: 'application/json', body: '{"ok":true}' }));

test('ключ дошёл не до всех: повтор из карточки группы, переживает перезапуск', async ({ page }) => {
  await openApp(page, '/more/family');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey, generateBoxKeyPair, exportBoxPublic } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    const ts = new Date().toISOString();
    const pub = async () => exportBoxPublic((await generateBoxKeyPair()).publicKey);
    // ownerSecret — исключать может только создатель группы.
    await db.family.put({
      id: 'f1', familyId: 'f1', familyToken: 't', familyKey: key, familyName: 'Наши',
      selfMemberId: 'me', lastSeq: 0, lastReadSeq: 0, enabled: true, joinedAt: ts,
      keyEpoch: 0, keyRing: { '0': key }, ownerSecret: 's', ownerMemberId: 'me',
    } as never);
    await db.familyMembers.bulkPut([
      { id: 'me', familyId: 'f1', seq: 1, displayName: 'Влад', color: '#5b7cfa', joinedAt: '2026-01-01', leftAt: null, removedAt: null },
      { id: 'm1', familyId: 'f1', seq: 2, displayName: 'Мама', color: '#ec4899', joinedAt: '2026-01-02', leftAt: null, removedAt: null, boxPub: await pub() },
      { id: 'p1', familyId: 'f1', seq: 3, displayName: 'Отец', color: '#10b981', joinedAt: '2026-01-03', leftAt: null, removedAt: null, boxPub: await pub() },
    ] as never[]);
  });
  await page.route(
    (u) => WORKER_MATCH.test(u.href) && u.pathname.endsWith('/family/remove'),
    (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
  await sendAnswers(page, 500);

  await page.goto('/more/family?g=f1&t=members');
  await page.getByRole('button', { name: 'Исключить Отец' }).click();
  await page.getByRole('button', { name: 'Исключить', exact: true }).click();

  // Исключение состоялось — шторка закрывается, повтор живёт в карточке.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const card = page.getByText('Новый ключ дошёл не до всех').locator('..');
  await expect(card).toContainText('Мама пока не видит новых сообщений');
  // Свой конверт владелец не видит в списке: его устройства получат ключ синком.
  await expect(card).not.toContainText('Влад');
  const retry = page.getByRole('button', { name: 'Отправить ключ ещё раз' });
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // Закрыл приложение — повтор никуда не делся.
  await page.reload();
  await expect(retry).toBeVisible();

  await retry.click();
  await expect(card.getByText('Снова не дошло. Проверьте интернет и попробуйте ещё раз.')).toBeVisible();

  await page.unroute(isSend);
  await sendAnswers(page, 200);
  await retry.click();
  await expect(page.getByText('Новый ключ отправлен')).toBeVisible();
  await expect(page.getByText('Новый ключ дошёл не до всех')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Исключить Мама' })).toBeVisible();
  await expect(page.getByText('Новый ключ дошёл не до всех')).toHaveCount(0);
});
