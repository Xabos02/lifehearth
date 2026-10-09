import { test, expect, openApp, type Page } from './fixtures';

// Переходы между экранами (NavRouter.tsx). Саму анимацию глазами здесь не
// проверить, зато ловится то, что ломается молча: что
// document.startViewTransition вообще вызывается (опция viewTransition у
// ссылок под BrowserRouter игнорируется без единой ошибки), с каким
// направлением — пометку источника легко потерять при правке ссылки, — и
// что CSS на это направление отвечает своими keyframes: селектор с пробелом
// перед «::» не срабатывает так же молча.

type Log = { __nav: string[]; __anim: string[] };

/** Подменяет startViewTransition: пишет направление каждого перехода и
 *  анимации, которые CSS повесил на слой ленты. */
async function recordTransitions(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as Log;
    w.__nav = [];
    w.__anim = [];
    const orig = document.startViewTransition.bind(document);
    document.startViewTransition = (arg?: Parameters<typeof orig>[0]) => {
      w.__nav.push(document.documentElement.dataset.nav ?? '');
      const vt = orig(arg);
      vt.ready.then(
        () =>
          w.__anim.push(
            document
              .getAnimations()
              .map((a) => (a as CSSAnimation).animationName)
              .filter((n) => n?.startsWith('nav-'))
              .sort()
              .join(' '),
          ),
        () => {},
      );
      return vt;
    };
  });
  return {
    navs: () => page.evaluate(() => (window as unknown as Log).__nav),
    anims: () => page.evaluate(() => (window as unknown as Log).__anim),
  };
}

test('вглубь, назад и по вкладке — каждый со своим направлением', async ({ page }) => {
  await openApp(page, '/home');
  const { navs, anims } = await recordTransitions(page);

  await page.locator('a[href$="/more/settings"]').first().click();
  await expect(page).toHaveURL(/\/more\/settings$/);
  // Стрелка «Назад» — переход ВПЕРЁД по истории на адрес родителя (§12);
  // направление «назад» ей даёт только пометка в state.
  await page.getByRole('link', { name: 'Назад', exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await page.locator('nav').getByRole('link', { name: 'Задачи' }).click();
  await expect(page).toHaveURL(/\/tasks$/);

  await expect.poll(navs).toEqual(['push', 'pop', 'tab']);
  await expect.poll(anims).toEqual(['nav-in-right nav-out-left', 'nav-in-left nav-out-right', 'nav-tab-in']);
  // Атрибут, а с ним и имя слоя ленты, — только на время перехода.
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.nav ?? null)).toBeNull();
});

test('при «уменьшении движения» экран меняется без перехода', async ({ page }) => {
  await openApp(page, '/home');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { navs } = await recordTransitions(page);

  await page.locator('a[href$="/more/settings"]').first().click();
  await expect(page).toHaveURL(/\/more\/settings$/);
  expect(await navs()).toEqual([]);
});
