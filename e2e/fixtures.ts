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
export const OPEN_METEO_MATCH = /api\.open-meteo\.com/;

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
        // Обязательный шаг приоритета разделов идёт сразу после тура и лежит
        // поверх всего экрана (SectionsPriorityGate, fixed inset-0): без этой
        // отметки он перехватывает клики во всех тестах, а не только в своих.
        sectionsPriorityDone: new Date().toISOString(),
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
        // Согласие на внешнее (задача 34) дано: без него окно «Что уходит с
        // телефона» перекрыло бы экран, а синк, семья, ИИ и напоминания стояли
        // бы на паузе. Тесты самого окна передают { consentAt: null }.
        consentAt: new Date().toISOString(),
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
/** Карточка группы (участники и управление) — нажатием на название в шапке
 *  чата, как в мессенджерах. Вкладок «Чат / Задачи / Участники» больше нет. */
export async function openFamilyCard(page: Page) {
  await page.getByRole('button', { name: /участники и настройки|members and settings/ }).click();
  await expect(page.getByRole('button', { name: /^(Выйти из группы|Leave the group)$/ })).toBeVisible();
}

/** Из карточки группы — обратно в её чат: «‹ <название>» в шапке. */
export async function backToFamilyChat(page: Page) {
  await page.getByRole('link', { name: /^(Назад|Back): / }).click();
  await expect(page.getByPlaceholder(/^(Сообщение…|Message…)$/)).toBeVisible();
}

/** Семья для списка чатов: общая группа «Наши» (я, Мама, Папа, Аня), личные
 *  чаты с мамой (два непрочитанных) и с Аней (фото), и пара, куда бабушка
 *  ещё не вошла по приглашению. memberId уникальны между группами, как в
 *  жизни: участник рождается заново в каждой группе. */
export async function seedFamilyChats(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const now = Date.now();
    const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    const groups = [
      { id: 'f1', name: 'Наши', self: 'me', read: 2 },
      { id: 'p-mom', name: 'Влад и Мама', self: 'me-mom', read: 1 },
      { id: 'p-anya', name: 'Влад и Аня', self: 'me-anya', read: 1 },
      { id: 'p-wait', name: 'Влад и Бабушка', self: 'me-wait', read: 0 },
    ];
    for (const [i, g] of groups.entries()) {
      const key = await generateKey();
      await db.family.put({
        id: g.id, familyId: g.id, familyToken: 't', familyKey: key, familyName: g.name,
        selfMemberId: g.self, lastSeq: 0, lastReadSeq: g.read, enabled: true,
        joinedAt: iso(10_000 - i), keyEpoch: 0, keyRing: { '0': key }, sortOrder: i,
      } as never);
    }
    const mk = (id: string, familyId: string, displayName: string, color: string) =>
      ({ id, familyId, seq: 1, displayName, color, joinedAt: iso(9_000), leftAt: null, removedAt: null });
    await db.familyMembers.bulkPut([
      mk('me', 'f1', 'Влад', '#5b7cfa'), mk('mom', 'f1', 'Мама', '#f472b6'),
      mk('dad', 'f1', 'Папа', '#7c9aff'), mk('anya', 'f1', 'Аня', '#4ade80'),
      mk('me-mom', 'p-mom', 'Влад', '#5b7cfa'), mk('mom2', 'p-mom', 'Мама', '#f472b6'),
      mk('me-anya', 'p-anya', 'Влад', '#5b7cfa'), mk('anya2', 'p-anya', 'Аня', '#ffffff'),
      mk('me-wait', 'p-wait', 'Влад', '#5b7cfa'),
    ] as never[]);
    const msg = (id: string, familyId: string, seq: number, from: string, text: string, minAgo: number, extra = {}) =>
      ({ clientMsgId: id, familyId, seq, senderMemberId: from, text, createdAt: iso(minAgo), status: 'acked', deletedAt: null, ...extra });
    await db.familyMessages.bulkPut([
      msg('a1', 'f1', 1, 'dad', 'Кто в субботу едет на дачу?', 200),
      msg('a2', 'f1', 2, 'me', 'Возьму. Во сколько выходим?', 60),
      msg('b1', 'p-mom', 1, 'me-mom', 'Да, до утра. Завтра заеду', 40),
      msg('b2', 'p-mom', 2, 'mom2', 'Возьми ключи от дачи', 20),
      msg('b3', 'p-mom', 3, 'mom2', 'Как ты сегодня?', 5),
      msg('c1', 'p-anya', 1, 'anya2', '', 60 * 30, { image: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }),
    ] as never[]);
    const task = (id: string, title: string, done = false) => ({
      id, familyId: 'f1', seq: 1, title, notes: '', priority: 0, dueDate: null, dueTime: null,
      remindBefore: null, color: null, assigneeId: null, createdBy: 'me', sortOrder: 1,
      completedAt: done ? iso(30) : null, completedBy: done ? 'me' : null, deletedAt: null,
    });
    await db.familyTasks.bulkPut([
      task('t1', 'Купить молоко'), task('t2', 'Забрать колёса'), task('t3', 'Оплатить свет'), task('t4', 'Вынести мусор', true),
    ] as never[]);
  });
}

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
    // Погода — сторонний сервис: каждый тест, открывавший «Сегодня», ходил в
    // настоящий Open-Meteo. Тест, которому нужна погода, ставит свой ответ.
    await context.route(OPEN_METEO_MATCH, (route) => route.abort('failed'));
    await run(context);
  },
});
export { expect };
