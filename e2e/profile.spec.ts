import { test, expect, openApp } from './fixtures';

// Профиль: карточка о себе, а не анкета.
//
// История трёх дефектов, которые здесь закрыты:
// 1. Дата рождения показывалась нативным полем в формате СИСТЕМЫ, а не языка
//    приложения — «06/29/1998» вместо «29 июня 1998». Владелец приложения
//    посмотрел на это и спросил, что за дата.
// 2. Имя, рост и вес сохранялись по кнопке, а пол на том же экране — сразу.
//    Две разные механики на одном экране, и человек не может знать, какая где.
// 3. Рост и вес лежали числами, из которых ничего не следовало.

test('дата рождения читается словами, а рядом — возраст', async ({ page }) => {
  await openApp(page, '/home/profile');
  await page.getByLabel('Дата рождения').fill('1998-06-29');

  // Нативное поле остаётся (системный календарь удобнее самодельного), но
  // рядом появляется человеческая подпись.
  await expect(page.getByText('29 июня 1998')).toBeVisible();
  // Возраст — то, ради чего дату и вводят.
  await expect(page.getByText(/\d+ (год|года|лет)/)).toBeVisible();
});

test('изменения сохраняются сами, без кнопки', async ({ page }) => {
  await openApp(page, '/home/profile');
  // Кнопки «Сохранить» на экране больше нет вовсе.
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toHaveCount(0);

  await page.getByLabel('Имя').fill('Влад');
  // Отметка появляется в дереве только после записи — по ней и ждём, иначе
  // проверка проскакивает вперёд самой записи.
  await expect(page.getByText('Сохранено')).toBeVisible();

  // И переживают перезагрузку — то есть действительно записались.
  await page.reload();
  await expect(page.getByLabel('Имя')).toHaveValue('Влад');
});

test('рост и вес превращаются в индекс массы тела', async ({ page }) => {
  await openApp(page, '/home/profile');
  await page.getByLabel('Рост, см').fill('178');
  await page.getByLabel('Вес, кг').fill('70');

  const bmi = page.getByText('Индекс массы тела');
  await expect(bmi).toBeVisible();
  await expect(page.getByText('22,1')).toBeVisible();
  await expect(page.getByText('норма')).toBeVisible();

  // Пока данных не хватает — строки нет: пустой показатель хуже отсутствующего.
  await page.getByLabel('Вес, кг').fill('');
  await expect(bmi).toHaveCount(0);
});

test('шапка показывает, кто это, одной строкой', async ({ page }) => {
  await openApp(page, '/home/profile');
  await page.getByLabel('Имя').fill('Влад');
  await page.getByLabel('Дата рождения').fill('1998-06-29');
  await page.getByLabel('Рост, см').fill('178');
  await page.getByLabel('Вес, кг').fill('70');

  // Возраст вместо даты: сколько человеку лет, понятнее, чем когда он родился.
  await expect(page.getByText(/\d+ лет · 178 см · 70 кг/)).toBeVisible();
});

// Уход с экрана раньше паузы автосохранения дописывает последнее нажатие. Эта
// запись брала профиль из ПЕРВОГО кадра экрана, когда база ещё не ответила:
// аватар стирался, а прежний вес считался новым и ложился в дневник замером
// на сегодня — точка, которой не было, и на всех устройствах поверх
// сегодняшнего настоящего веса.
test('быстрый уход из профиля не стирает аватар и не добавляет замер веса', async ({ page }) => {
  const avatar = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  await openApp(page, '/home', { profile: { name: 'Аня', avatar, heightCm: 170, weightKg: 80 } });
  const earlier = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { addDaysKey, todayKey } = await import('/src/lib/dates.ts');
    const date = addDaysKey(todayKey(), -5);
    const at = new Date().toISOString();
    await db.metricLogs.put({
      id: `health:weight:${date}`, metricId: 'health:weight', date, value: 80,
      createdAt: at, updatedAt: at, deletedAt: null,
    } as never);
    return date;
  });
  // Переход внутри приложения, а не goto: экран монтируется заново, и его
  // первый кадр рисуется до ответа базы — как у человека.
  await page.locator('a[href="/home/profile"]').click();
  await expect(page.getByLabel('Имя')).toHaveValue('Аня');
  // Набор и «Назад» — одним заходом в страницу, а не двумя шагами Playwright:
  // под нагрузкой между ними легко набегали бы 600 мс паузы, и сохранение
  // успевало бы по таймеру — тест прошёл бы мимо ошибки.
  await page.evaluate(async () => {
    const input = [...document.querySelectorAll('input')].find((i) => i.value === 'Аня')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Аня К');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    // Стрелка подписана разделом: «Назад: Главная».
    document.querySelector<HTMLAnchorElement>('a[aria-label^="Назад"]')!.click();
  });

  const read = () =>
    page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      const p = (await db.settings.get('app'))?.profile;
      const logs = (await db.metricLogs.toArray()).filter((l) => !l.deletedAt).map((l) => `${l.date}=${l.value}`);
      return { name: p?.name, avatar: Boolean(p?.avatar), weightKg: p?.weightKg, logs };
    });
  // Последнее нажатие дописано — значит запись при уходе уже прошла.
  await expect.poll(async () => (await read()).name).toBe('Аня К');
  // Замер пишется следом за профилем: даём ему время, прежде чем утверждать,
  // что его нет.
  await page.waitForTimeout(500);
  expect(await read()).toEqual({ name: 'Аня К', avatar: true, weightKg: 80, logs: [`${earlier}=80`] });
});

// Скептик починки профиля (15.11.2026): вес теперь приходит в профиль и
// синком. Черновик, начатый до него, держал прежний вес и при сохранении
// возвращал его в профиль и в дневник замером на сегодня — поверх настоящего.
test('вес с другого устройства, пришедший посреди набора имени, не откатывается', async ({ page }) => {
  await openApp(page, '/home', { profile: { name: 'Аня', heightCm: 170, weightKg: 80 } });
  await page.locator('a[href="/home/profile"]').click();
  await expect(page.getByLabel('Имя')).toHaveValue('Аня');
  // Набор и приход веса — одним заходом в страницу: между двумя шагами
  // Playwright под нагрузкой легко набегают 600 мс паузы, черновик успевал бы
  // сохраниться до веса, и тест прошёл бы мимо гонки.
  const today = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { todayKey } = await import('/src/lib/dates.ts');
    const { syncProfileWeight } = await import('/src/features/health/measures.ts');
    // Начали печатать имя — черновик открыт, вес в нём прежний.
    const input = [...document.querySelectorAll('input')].find((i) => i.value === 'Аня')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Аня К');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Пока человек печатает, синк приносит сегодняшний вес и доводит его до
    // профиля — тем же путём, что pullPage (sync.ts).
    const date = todayKey();
    const at = new Date().toISOString();
    await db.metricLogs.put({
      id: `health:weight:${date}`, metricId: 'health:weight', date, value: 78.4,
      createdAt: at, updatedAt: at, deletedAt: null,
    } as never);
    await syncProfileWeight();
    return date;
  });
  const read = () =>
    page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      const prof = (await db.settings.get('app'))?.profile;
      const logs = (await db.metricLogs.toArray()).filter((l) => !l.deletedAt).map((l) => `${l.date}=${l.value}`);
      return { name: prof?.name, weightKg: prof?.weightKg, logs };
    });
  // Имя сохранилось само — значит запись черновика прошла.
  await expect.poll(async () => (await read()).name).toBe('Аня К');
  await page.waitForTimeout(500);
  expect(await read()).toEqual({ name: 'Аня К', weightKg: 78.4, logs: [`${today}=78.4`] });
});

