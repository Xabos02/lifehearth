import { expect } from '@playwright/test';
import { openApp, test } from './fixtures';

// Сторож: браузерные тесты не имеют права стучаться в боевой сервер.
//
// Так уже случилось. Адрес сервера был вписан в код строкой, тесты заводят
// включённую семейную группу (иначе чат нечем проверять), а движок чата сам,
// без единого клика, держит связь и восстанавливает её при обрыве. Значит
// каждый прогон и каждая забытая открытая вкладка били в живой сервер семьи —
// с адреса, которого нет в списке разрешённых, то есть получая отказ и заходя
// на новый круг каждые три секунды. 5-8 сентября 2026 так был выбран дневной
// лимит бесплатного плана Cloudflare, и обмен встал у всех разом.
//
// Сам по себе перехват сети в фикстуре эту дыру не закрывает: он глушит
// последствие, а не причину. Причина — адрес. Поэтому тест смотрит не на то,
// удался ли запрос, а на то, КУДА он был направлен: любое обращение к боевому
// домену — красный тест, даже если фикстура его оборвала.
test('приложение в тесте не обращается к боевому серверу', async ({ page }) => {
  const live: string[] = [];
  page.on('request', (r) => {
    if (/life-hub-push\.xabos161rus\.workers\.dev/.test(r.url())) live.push(r.url());
  });

  await openApp(page);
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    const ts = new Date().toISOString();
    await db.family.put({
      id: 'guard', familyId: 'guard', familyToken: 't', familyKey: key, familyName: 'Сторож',
      selfMemberId: 'me', lastSeq: 0, lastReadSeq: 0, enabled: true, joinedAt: ts,
      keyEpoch: 0, keyRing: { '0': key },
    } as never);
  });
  await page.reload();

  // Три паузы переподключения подряд: старый код ходил каждые три секунды,
  // так что за десять секунд боевой адрес всплыл бы наверняка.
  await page.waitForTimeout(10_000);

  expect(live, `запросы в боевой сервер из теста:\n${live.join('\n')}`).toEqual([]);
});
