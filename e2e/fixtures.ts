import { test as base, expect, type Page } from '@playwright/test';

// Общая подготовка браузерных тестов.
//
// При первом запуске приложение показывает три перекрывающих экрана подряд:
// онбординг, напоминание о переустановке и «Что нового». Кликать через них в
// каждом тесте — значит половину каждого теста писать про них, а не про то,
// что проверяется. Поэтому флаги ставятся напрямую в IndexedDB.
//
// Версии этих флагов НЕ захардкожены: они читаются из тех же модулей, что и в
// приложении, — но внутри страницы, через дев-сервер Vite. Импортировать те же
// файлы здесь, в Node, нельзя: в них `import.meta.env`, которого вне сборки
// не существует. А захардкодить — значит после каждой смены версии ловить
// падение теста на всплывшем окне и искать причину заново.
//
// Отсюда два прохода: первая загрузка поднимает приложение (и создаёт схему
// Dexie), потом ставятся флаги, потом перезагрузка уже в чистое состояние.

// Адрес сервера в любом его виде: боевой (если кто-то соберёт прод-бандл) и
// локальный из .env.development. По этой маске тесты и глушат сеть, и ставят
// свои подставные ответы — маска одна, чтобы они не разъехались.
export const WORKER_MATCH = /(workers\.dev|127\.0\.0\.1:8787)/;

export interface SeedSettings {
  [key: string]: unknown;
}

/** Открыть приложение с пройденным онбордингом. */
export async function openApp(page: Page, path = '', extraSettings: SeedSettings = {}) {
  await page.goto(path);
  await expect(page.locator('#root')).toBeVisible();

  const versions = await page.evaluate(async () => {
    const [install, changelog] = await Promise.all([
      import('/src/lib/appInstall.ts'),
      import('/src/lib/changelog.ts'),
    ]);
    return { reinstall: install.REINSTALL_NOTICE_VERSION, app: changelog.APP_VERSION };
  });

  await page.evaluate(
    async ({ versions, extra }) => {
      const { db } = await import('/src/db/db.ts');
      const prev = (await db.settings.get('app')) ?? { id: 'app' };
      await db.settings.put({
        ...prev,
        id: 'app',
        onboardingDone: new Date().toISOString(),
        reinstallNoticeSeen: versions.reinstall,
        lastSeenVersion: versions.app,
        // Женский профиль по умолчанию: без пола приложение закрыто гейтом
        // первого запуска, а раздел «Женские дни» (его проверяет добрая часть
        // тестов) существует только в женском. Тесты мужского профиля и самого
        // гейта переопределяют это через extraSettings / чистый заход.
        gender: 'female',
        // Язык — явно русский: headless-Chromium живёт с navigator.language
        // en-US, и «как в системе» дал бы английский интерфейс — все тексты
        // существующих тестов перестали бы находиться. EN-тесты переопределяют.
        language: 'ru',
        ...extra,
      });
    },
    { versions, extra: extraSettings },
  );

  // Именно goto(path), а не reload(): первый заход случается ДО сидинга, и
  // маршруты, закрытые по полу (RequireFemale), успевают редиректнуть на
  // «Главную» — reload перезагрузил бы уже подменённый адрес, и тест молча
  // оказался бы не на том экране.
  await page.goto(path);
  await expect(page.locator('#root')).not.toBeEmpty();
  // Ленивые чанки разделов подгружаются после первого кадра.
  await page.waitForLoadState('networkidle').catch(() => {});
}

/** Ошибки в консоли и необработанные исключения за время теста. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Недоступный воркер — нормальное состояние теста: семейный чат и синк
    // стучатся наружу, и в изоляции им отвечать некому.
    if (/Failed to load resource|net::ERR_|workers\.dev|WebSocket/i.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

// Тесты не выходят в интернет — это не вежливость, а защита боевого сервера.
//
// Приложение в тесте живёт с включённой семейной группой (иначе нечего
// проверять), а значит само, без единого клика, начинает держать связь с
// сервером и восстанавливать её при обрыве. Пока адрес был вписан в код
// строкой, «сервер» означал боевой: каждый прогон и каждая забытая открытая
// вкладка стучались в живой сервер семьи. За ночь 7-8 сентября 2026 так был
// выбран дневной лимит бесплатного плана, и обмен встал у всех.
//
// Адрес теперь берётся из окружения (src/lib/workerUrl.ts), но одной этой
// меры мало: она держится на том, что .env.development на месте. Здесь стоит
// вторая, независимая: запросы к серверу обрываются на уровне браузера.
// Тест, которому нужен подставной сервер, ставит свой обработчик позже —
// в Playwright побеждает последний зарегистрированный, поэтому эта заглушка
// ему не мешает (см. sync-two-devices.spec.ts).
export const test = base.extend({
  // Второй аргумент Playwright называет `use`; здесь он `run`, потому что
  // на имени `use` линтер видит React-хук вне компонента и краснеет.
  context: async ({ context }, run) => {
    await context.route(WORKER_MATCH, (route) => route.abort('failed'));
    await context.routeWebSocket(WORKER_MATCH, (ws) => ws.close());
    await run(context);
  },
});
export { expect };
