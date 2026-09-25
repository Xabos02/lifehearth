import type { Page } from '@playwright/test';
import { openApp, test, expect } from './fixtures';

// Раздел «ИИ» (этап 1, заглушка). Воркер в изоляции недоступен, поэтому
// эндпоинт /ai/chat мокается на уровне сети — ответ в формате echoReply.

/** Синк-конфиг напрямую в Dexie: aiClient без него отказывает ещё до сети. */
async function seedSyncAccount(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    await db.sync.put({
      id: 'config',
      accountId: 'acc-e2e',
      authToken: 'tok-e2e',
      key: await generateKey(),
      enabled: true,
      lastPullAt: '',
      lastPushAt: '',
      lastSyncedAt: '',
    });
  });
}

test('раздел скрыт с «Главной» по умолчанию, но открывается по прямому адресу', async ({ page }) => {
  await openApp(page, '/home');
  // Флаг выключен — пункта «ИИ» в списке «Главной» нет.
  await expect(page.getByRole('link', { name: 'ИИ', exact: true })).toHaveCount(0);

  await page.goto('/more/ai');
  await expect(page.getByPlaceholder('Сообщение…')).toBeVisible();
});

test('первый вход заводит ровно один чат — и после перезагрузки он всё ещё один', async ({ page }) => {
  await openApp(page, '/more/ai');
  await expect(page.getByPlaceholder('Сообщение…')).toBeVisible();
  await expect
    .poll(async () => page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      return (await db.llmChats.toArray()).filter((c) => !c.deletedAt).length;
    }))
    .toBe(1);

  await page.goto('/more/ai');
  await expect(page.getByPlaceholder('Сообщение…')).toBeVisible();
  // Ждём вторичного захода эффекта: число чатов не должно вырасти.
  await page.waitForTimeout(400);
  const after = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    return (await db.llmChats.toArray()).filter((c) => !c.deletedAt).length;
  });
  expect(after).toBe(1);
});

test('без настроенной синхронизации отправка даёт понятную ошибку, не пустоту', async ({ page }) => {
  await openApp(page, '/more/ai');
  const input = page.getByPlaceholder('Сообщение…');
  await input.fill('привет');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByText('Включите синхронизацию в Настройках — она нужна для авторизации.')).toBeVisible();
});

test('живой провайдер: SSE-стрим печатается, usage превращается в цену, обрыв по length виден', async ({ page }) => {
  // Мок SSE-ответа воркера: формат OpenAI chat completions + include_usage.
  const sse = [
    'data: {"choices":[{"delta":{"content":"Стрим "},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":"работает"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":9}}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  await page.route('**/ai/chat', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: sse }),
  );
  await openApp(page, '/more/ai');
  await seedSyncAccount(page);
  // Живая модель выбирается в композере и запоминается в чате.
  await page.getByRole('button', { name: 'Модель' }).click();
  await page.getByRole('button', { name: /Claude Sonnet 5/ }).click();

  await page.getByPlaceholder('Сообщение…').fill('стримни');
  await page.getByRole('button', { name: 'Отправить' }).click();

  await expect(page.getByText('Стрим работает')).toBeVisible();
  await expect(page.getByText('40→9')).toBeVisible();
  // Ответ упёрся в max_tokens — приписка об обрыве обязана быть видимой.
  await expect(page.getByText('Ответ обрезан лимитом токенов.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Дописать' })).toBeVisible();
  // Цена в шапке: сумма чата из usage и прайса модели.
  await expect(page.getByText(/за чат: /)).toBeVisible();
});

test('сквозной тракт: вопрос → эхо-ответ с ценой → история переживает перезагрузку', async ({ page }) => {
  // Мок воркера: тот же формат, что отдаёт echoReply в worker/src/index.js.
  await page.route('**/ai/chat', (route) =>
    route.fulfill({
      contentType: 'application/json',
      json: {
        content: '**Заглушка-эхо.** Ответ для теста.',
        model: 'echo',
        usage: { in: 12, out: 34 },
      },
    }),
  );
  await openApp(page, '/more/ai');
  await seedSyncAccount(page);

  const input = page.getByPlaceholder('Сообщение…');
  await input.fill('вопрос для эха');
  await page.getByRole('button', { name: 'Отправить' }).click();

  // Ответ отрисован markdown-ом, метаданные — токены и цена заглушки одной
  // строкой (просто «бесплатно» совпало бы ещё и с лейблом модели).
  await expect(page.getByText('Заглушка-эхо.')).toBeVisible();
  await expect(page.getByText('12→34 · бесплатно')).toBeVisible();

  await page.goto('/more/ai');
  await expect(page.getByText('Заглушка-эхо.')).toBeVisible();
  // Заголовок чата взялся из первого вопроса.
  await expect(page.getByRole('heading', { name: 'вопрос для эха' })).toBeVisible();
});

test('доступ к данным: модель вызывает инструмент, отвечает по фактам, след виден чипом', async ({ page }) => {
  // Два запроса цикла tool use. Первый — модель просит list_tasks (дельты
  // вызова нарочно порваны между событиями). Второй — обязан принести роль
  // tool с результатом; отвечаем финальным текстом.
  const callRound = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"list_tasks","arguments":""}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":5}}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  const finalRound = [
    'data: {"choices":[{"delta":{"content":"Открыта одна задача: полить фикус."},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":80,"completion_tokens":12}}',
    'data: [DONE]',
    '',
  ].join('\n\n');

  const bodies: string[] = [];
  await page.route('**/ai/chat', (route) => {
    bodies.push(route.request().postData() ?? '');
    return route.fulfill({
      contentType: 'text/event-stream',
      body: bodies.length === 1 ? callRound : finalRound,
    });
  });

  await openApp(page, '/more/ai');
  await seedSyncAccount(page);
  // Реальная запись в Dexie — инструмент читает её, а не фикстуру теста.
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    await db.tasks.add({
      id: 'e2e-task',
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      title: 'полить фикус',
      notes: '',
      projectId: null,
      goalId: null,
      priority: 0,
      dueDate: null,
      dueTime: null,
      duration: null,
      remindBefore: null,
      completedAt: null,
      checklist: [],
      recurrence: null,
      tags: [],
      sortOrder: 1000,
    } as never);
  });
  await page.getByRole('button', { name: 'Модель' }).click();
  await page.getByRole('button', { name: /Claude Sonnet 5/ }).click();
  // Доступ к данным по умолчанию выключен (решение 25.09) — включает человек.
  await page.getByRole('button', { name: 'Доступ к данным' }).click();

  await page.getByPlaceholder('Сообщение…').fill('что по задачам?');
  await page.getByRole('button', { name: 'Отправить' }).click();

  await expect(page.getByText('Открыта одна задача: полить фикус.')).toBeVisible();
  // Чип следа: имя инструмента по-русски и число найденного.
  await expect(page.getByText('Задачи · 1')).toBeVisible();
  // Стоимость просуммирована по обоим раундам цикла.
  await expect(page.getByText('110→17')).toBeVisible();

  // Первый запрос нёс определения инструментов; второй — результат вызова.
  expect(bodies[0]).toContain('"tools"');
  expect(bodies[0]).toContain('list_tasks');
  const second = JSON.parse(bodies[1]) as { messages: { role: string; content?: string }[] };
  const toolMsg = second.messages.find((m) => m.role === 'tool');
  expect(toolMsg?.content).toContain('полить фикус');
});

test('ответ не двоится: поток гаснет до того, как сообщение придёт из базы', async ({ page }) => {
  // Пока ответ печатался потоком, он жил отдельным блоком. Запись в базу и
  // снятие потока шли друг за другом, и между ними лента показывала ответ
  // ДВАЖДЫ — сохранённым сообщением и всё ещё живым потоком. На быстрой
  // машине это мелькание в один кадр, на медленной — заметное двоение (и
  // случайно красный тест, который ищет текст ответа).
  await page.route('**/ai/chat', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: [
        'data: {"choices":[{"delta":{"content":"Ответ, который не должен двоиться"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
        'data: [DONE]',
        '',
      ].join('\n\n'),
    }),
  );

  await openApp(page, '/more/ai');
  await seedSyncAccount(page);

  await page.evaluate(() => {
    const w = window as unknown as { __maxSeen: number };
    w.__maxSeen = 0;
    const count = () => {
      const n = Array.from(document.querySelectorAll('*')).filter(
        (el) =>
          el.children.length === 0 &&
          (el.textContent ?? '').includes('Ответ, который не должен двоиться'),
      ).length;
      if (n > w.__maxSeen) w.__maxSeen = n;
    };
    new MutationObserver(count).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  await page.getByPlaceholder('Сообщение…').fill('привет');
  await page.getByRole('button', { name: 'Отправить' }).click();

  const answer = page.getByText('Ответ, который не должен двоиться');
  await expect(answer).toBeVisible();
  await page.waitForTimeout(400);
  await expect(answer).toHaveCount(1);

  // Одной проверки «в конце их не два» мало: двоение живёт доли секунды, и
  // на быстрой машине проверка приходит уже после него. Наблюдатель считает
  // вхождения на КАЖДОЕ изменение разметки и помнит максимум — так в кадр
  // попадает и мелькание.
  expect(await page.evaluate(() => (window as unknown as { __maxSeen: number }).__maxSeen)).toBe(1);
});

test('доступ к данным по умолчанию выключен: запрос уходит без tools, включение запоминается', async ({ page }) => {
  const bodies: string[] = [];
  await page.route('**/ai/chat', (route) => {
    bodies.push(route.request().postData() ?? '');
    return route.fulfill({
      contentType: 'application/json',
      json: { content: 'ответ без данных', model: 'echo', usage: { in: 1, out: 2 } },
    });
  });
  await openApp(page, '/more/ai');
  await seedSyncAccount(page);

  // Прочитанное уходит через наш воркер провайдеру открытым текстом, поэтому
  // без явного включения модель данных не видит (решение 25.09, задача 33).
  const toggle = page.getByRole('button', { name: 'Доступ к данным' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await page.getByPlaceholder('Сообщение…').fill('привет');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByText('ответ без данных')).toBeVisible();
  expect(bodies[0]).not.toContain('"tools"');

  // Включение запоминается в чате: после перезагрузки тумблер остаётся включён.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/more/ai');
  await expect(page.getByRole('button', { name: 'Доступ к данным' })).toHaveAttribute('aria-pressed', 'true');
});

test('пустой чат: подсказка отправляется одним тапом', async ({ page }) => {
  const bodies: string[] = [];
  await page.route('**/ai/chat', (route) => {
    bodies.push(route.request().postData() ?? '');
    return route.fulfill({
      contentType: 'application/json',
      json: { content: 'Разобрал.', model: 'echo', usage: { in: 1, out: 1 } },
    });
  });
  await openApp(page, '/more/ai');
  await seedSyncAccount(page);

  await page.getByRole('button', { name: 'Разбери мои расходы за месяц' }).click();
  await expect(page.getByText('Разобрал.')).toBeVisible();
  // Вопрос ушёл именно текстом подсказки и стал заголовком чата.
  expect(bodies[0]).toContain('Разбери мои расходы за месяц');
  await expect(page.getByRole('heading', { name: 'Разбери мои расходы за месяц' })).toBeVisible();
});

test('настройки чата: переименование и инструкция для модели сохраняются', async ({ page }) => {
  const bodies: string[] = [];
  await page.route('**/ai/chat', (route) => {
    bodies.push(route.request().postData() ?? '');
    return route.fulfill({
      contentType: 'application/json',
      json: { content: 'ок', model: 'echo', usage: { in: 1, out: 1 } },
    });
  });
  await openApp(page, '/more/ai');
  await seedSyncAccount(page);

  await page.getByRole('button', { name: 'Настройки чата' }).click();
  await page.getByLabel('Название').fill('Финансовый советник');
  await page.getByLabel('Инструкция для модели').fill('отвечай одним предложением');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByRole('heading', { name: 'Финансовый советник' })).toBeVisible();

  // Инструкция реально уезжает в запрос системным промптом.
  await page.getByPlaceholder('Сообщение…').fill('привет');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByText('ок', { exact: true })).toBeVisible();
  expect(bodies[0]).toContain('отвечай одним предложением');
});
