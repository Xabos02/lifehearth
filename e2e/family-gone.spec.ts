import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Группы больше нет — удалил создатель или исключили вас. Сказать об этом
// нужно сразу, без раскрытия «шторы» шапки: с 1.34.0 она по умолчанию
// свёрнута, и баннер внутри неё был не виден — чат выглядел живым, а
// сообщения в него уже не приходили.

async function seedFamily(page: Page, gone: { groupDeletedAt?: string; removedAt?: string }) {
  await page.evaluate(async (g) => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    const ts = new Date().toISOString();
    await db.family.put({
      id: 'f1', familyId: 'f1', familyToken: 't', familyKey: key, familyName: 'Наши',
      selfMemberId: 'me', lastSeq: 0, lastReadSeq: 0, enabled: true, joinedAt: ts,
      keyEpoch: 0, keyRing: { '0': key }, ...g,
    } as never);
    await db.familyMembers.bulkPut([
      { id: 'me', familyId: 'f1', seq: 1, displayName: 'Влад', color: '#5b7cfa', joinedAt: ts, leftAt: null, removedAt: null },
      { id: 'p1', familyId: 'f1', seq: 2, displayName: 'Отец', color: '#10b981', joinedAt: ts, leftAt: null, removedAt: null },
    ] as never[]);
    await db.familyMessages.bulkPut([
      { clientMsgId: 'a1', familyId: 'f1', seq: 1, senderMemberId: 'p1', text: 'Заберёшь колёса в субботу?', createdAt: ts, deletedAt: null },
    ] as never[]);
  }, gone);
  await page.goto('/more/family?g=f1');
}

/** Видно глазом, а не только в дереве. toBeVisible() такой баннер пропускает:
 *  в свёрнутой «шторе» он прозрачный и обрезан, но рамка у него ненулевая. */
async function seen(loc: Locator) {
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.height < 10) return false;
    for (let n: Element | null = el; n; n = n.parentElement) {
      if (Number(getComputedStyle(n).opacity) < 0.5) return false;
    }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return Boolean(hit && (hit === el || el.contains(hit)));
  });
}

test('удалённая создателем группа говорит об этом сразу, переписка на месте', async ({ page }) => {
  await openApp(page, '/more/family');
  await seedFamily(page, { groupDeletedAt: new Date().toISOString() });
  await expect.poll(() => seen(page.getByText('Эту группу удалил её создатель.', { exact: false }))).toBe(true);
  await expect(page.getByText('Заберёшь колёса в субботу?')).toBeVisible();
  // И никакого «не в сети» под названием: чинить связь незачем.
  await expect(page.locator('header').getByText('не в сети', { exact: false })).toHaveCount(0);
});

test('исключённый видит, что его исключили, без раскрытия шапки', async ({ page }) => {
  await openApp(page, '/more/family');
  await seedFamily(page, { removedAt: new Date().toISOString() });
  await expect.poll(() => seen(page.getByText('Вас исключили из этой группы.', { exact: false }))).toBe(true);
});
