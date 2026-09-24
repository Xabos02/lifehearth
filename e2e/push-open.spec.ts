import { expect } from '@playwright/test';
import { openApp, test } from './fixtures';

// Тап по уведомлению при открытом приложении: сервис-воркер шлёт адрес, мост
// (SwNavBridge) переводит роутер без перезагрузки. Уведомления, пришедшие до
// переезда 07.09, несут старый префикс /life-hub/ — с ним роутер показывал
// «страница не найдена» вместо чата.

for (const [what, url] of [
  ['нынешний адрес', '/more/family'],
  ['адрес до переезда', '/life-hub/more/family'],
] as const) {
  test(`тап по пушу семьи открывает чат: ${what}`, async ({ page }) => {
    await openApp(page, '/');
    await page.evaluate((u) => {
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'open-url', url: u } }));
    }, url);
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/more/family');
    await expect(page.getByText('Такого экрана нет')).toHaveCount(0);
  });
}
