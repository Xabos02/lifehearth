import { test, expect } from './fixtures';
import { openApp } from './fixtures';

// Английский интерфейс мигрированных разделов. Не перебор всех строк (это
// работа чекера словаря), а смоук на живом экране: язык действительно
// прорастает в разделы, включая пустые состояния и панель редактора.
// Русские тексты этих же экранов держат остальные спеки — фикстура сеет ru.

test('английский: раздел задач — экран, быстрый ввод, шит задачи', async ({ page }) => {
  await openApp(page, '/tasks', { language: 'en' });
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
  // Пустое состояние свежей базы.
  await expect(page.getByText('No tasks yet')).toBeVisible();
  await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible();
  // Шит новой задачи: заголовок и подписи полей. FAB подписан общим «Add»
  // (как в русских спеках «Добавить», exact) — 'Add task' занят стрелкой
  // быстрого ввода.
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New task' })).toBeVisible();
  await expect(page.getByText('Repeat', { exact: true })).toBeVisible();
});

test('английский: быстрый ввод понимает естественные даты', async ({ page }) => {
  await openApp(page, '/tasks', { language: 'en' });
  const input = page.getByPlaceholder('What needs to be done?');
  // Фраза из подсказки Hint — обещание интерфейса, проверяем его дословно.
  await input.fill('call mom tomorrow at 10');
  // Живая подсказка разбора: дата, время.
  await expect(page.getByText('tomorrow · at 10:00')).toBeVisible();
  await input.press('Enter');
  // Задача создана: заголовок очищен от токенов, срок виден строкой задачи.
  const row = page.getByText('call mom', { exact: true });
  await expect(row).toBeVisible();
  await expect(page.getByText('Tomorrow, 10:00')).toBeVisible();
});

test('английский: системные сообщения чата локализуются у зрителя', async ({ page }) => {
  await openApp(page, '/more/family', { language: 'en' });
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    await db.family.put({
      id: 'f1', familyId: 'f1', familyToken: 't', familyKey: key, familyName: 'Family',
      selfMemberId: 'me', lastSeq: 0, lastReadSeq: 0, enabled: true,
      joinedAt: new Date().toISOString(), keyEpoch: 0, keyRing: { '0': key },
    });
    await db.familyMembers.bulkPut([
      { id: 'me', familyId: 'f1', seq: 1, displayName: 'Anna', color: '#5b7cfa', joinedAt: new Date().toISOString(), leftAt: null, removedAt: null },
    ]);
    const msg = (id: string, seq: number, text: string, over: Record<string, unknown> = {}) => ({
      clientMsgId: id, familyId: 'f1', seq, senderMemberId: 'me',
      createdAt: new Date(Date.now() - (10 - seq) * 60000).toISOString(),
      text, system: true, status: 'acked', deletedAt: null, ...over,
    });
    await db.familyMessages.bulkPut([
      // Типизированные события с русским text (язык отправителя): зритель с
      // английским интерфейсом обязан увидеть их по-английски.
      msg('sm1', 1, 'Вася присоединился', { sys: { kind: 'join', name: 'Вася' } }),
      msg('sm2', 2, '📞 Аудиозвонок · 3:07', { sys: { kind: 'call', sec: 187 } }),
      // Старая история — строка без события: показывается дословно.
      msg('sm3', 3, 'Мама присоединилась'),
    ]);
  });
  await page.goto('/more/family?g=f1');
  await expect(page.getByText('Вася is now in the group')).toBeVisible();
  await expect(page.getByText('📞 Audio call · 3:07')).toBeVisible();
  await expect(page.getByText('Мама присоединилась')).toBeVisible();
});

test('английский: раздел заметок — список, папки, редактор', async ({ page }) => {
  await openApp(page, '/notes', { language: 'en' });
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await expect(page.getByText('No notes yet')).toBeVisible();
  // Шит новой папки.
  await page.getByRole('button', { name: 'New folder' }).click();
  await expect(page.getByText('Icon', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create folder' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  // Редактор: панель инструментов и стили за «Aa».
  await openApp(page, '/notes/new', { language: 'en' });
  await page.locator('.note-editor').click();
  await page.getByRole('button', { name: 'Format' }).click();
  await expect(page.getByRole('button', { name: 'Quote', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Body text' })).toBeVisible();
});

test('английский: одно русское слово в разных местах — перевод по смыслу места', async ({ page }) => {
  // Ключ словаря — сама русская строка, а у «Включить», «Обучение», «Занято»,
  // «Убрать» смыслов больше одного. Сторож покрытия такого не видит: пара в
  // словаре есть, просто она про другой экран. После переделки настроек 22.08
  // там стояли «Unmute» у уведомлений (смысл с микрофона звонка), «Learning» у
  // тура (раздел «Обучение») и «Busy» у объёма хранилища (линия занята), а
  // крестик вида в тренировке озвучивался «Clear» (очистить срок задачи).
  await openApp(page, '/more/settings', { language: 'en' });
  await expect(page.getByRole('button', { name: 'Turn on', exact: true })).toBeVisible();
  await expect(page.getByText('Intro tour', { exact: true })).toBeVisible();
  await expect(page.getByText(/Unmute|Learning/)).toHaveCount(0);

  // На звонке тот же «Включить» под перечёркнутым микрофоном — «Unmute».
  // Звонок без сети не поднять, поэтому снимок «идёт разговор, микрофон
  // выключен» кладётся прямо в менеджер (громкая связь — без блокировки щекой).
  await page.evaluate(async () => {
    const { callManager } = await import('/src/lib/family/familyCall.ts');
    (callManager as unknown as { set(p: object): void }).set({
      status: 'active', peerName: 'Dad', muted: true, speakerOn: true, startedAt: Date.now(),
    });
  });
  await expect(page.getByRole('button', { name: 'Unmute', exact: true })).toBeVisible();

  await openApp(page, '/more/settings/backup', { language: 'en' });
  await expect(page.getByText('Used', { exact: true })).toBeVisible();
  await expect(page.getByText('Busy', { exact: true })).toHaveCount(0);

  await openApp(page, '/more/health', { language: 'en' });
  await page.getByRole('button', { name: 'Log a workout' }).click();
  await page.getByRole('button', { name: 'Add another exercise' }).click();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'From template' }).click();
  await page.getByRole('button', { name: 'New template' }).click();
  await page.getByRole('button', { name: 'Add another exercise' }).last().click();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Clear', exact: true })).toHaveCount(0);
});
