import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test, WORKER_MATCH } from './fixtures';

// Семейные задачи: напоминание, поставленное без сети.
//
// Разбор работы 20.09 (задача 26, 862184e): напоминание семейной задачи,
// поставленное без сети, очередь повторов искала только среди личных задач и
// молча выбрасывала — оно не срабатывало никогда.

async function seed(page: Page, extra: { sub?: boolean; retry?: string[] } = {}) {
  await page.evaluate(async (extra) => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    const ts = new Date().toISOString();
    await db.family.put({
      id: 'f1', familyId: 'f1', familyToken: 't', familyKey: key, familyName: 'Наши',
      selfMemberId: 'me', lastSeq: 0, lastReadSeq: 0, enabled: true, joinedAt: ts,
      keyEpoch: 0, keyRing: { '0': key },
    } as never);
    await db.familyMembers.bulkPut([
      { id: 'me', familyId: 'f1', seq: 1, displayName: 'Влад', color: '#5b7cfa', joinedAt: ts, leftAt: null, removedAt: null },
      { id: 'p1', familyId: 'f1', seq: 2, displayName: 'Отец', color: '#10b981', joinedAt: ts, leftAt: null, removedAt: null },
    ] as never[]);
    const base = {
      familyId: 'f1', seq: 5, notes: '', priority: 0, dueDate: null, dueTime: null, remindBefore: null,
      color: null, assigneeId: null, createdBy: 'me', completedAt: null, completedBy: null, deletedAt: null,
    };
    await db.familyTasks.bulkPut([
      // Срок далеко впереди: напоминание «за день» не должно оказаться в прошлом.
      { ...base, id: 'a', title: 'Купить хлеб', dueDate: '2099-01-10', remindBefore: 1440, sortOrder: 3000 },
      { ...base, id: 'b', title: 'Позвонить бабушке', sortOrder: 2000 },
      { ...base, id: 'c', title: 'Забрать колёса', sortOrder: 1000 },
    ] as never[]);
    if (extra.sub) {
      localStorage.setItem('life-hub-push-sub', JSON.stringify({ endpoint: 'https://push.example/x' }));
    }
    if (extra.retry) localStorage.setItem('life-hub-reminder-retry', JSON.stringify(extra.retry));
  }, extra);
  await page.goto('/more/family?g=f1&t=tasks');
  await expect(page.getByText('Забрать колёса', { exact: true })).toBeVisible();
}

test('напоминание семейной задачи, не поставленное без сети, ставится при возвращении', async ({ page }) => {
  const calls: { path: string; taskId?: string }[] = [];
  await openApp(page, '/more/family');
  // Подставной сервер напоминаний. Регистрируется позже заглушки фикстуры —
  // в Playwright побеждает последний обработчик.
  await page.context().route(WORKER_MATCH, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/schedule' || url.pathname === '/cancel') {
      calls.push({ path: url.pathname, taskId: route.request().postDataJSON()?.taskId });
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    await route.abort('failed');
  });
  // Так очередь выглядит после сохранения задачи в метро: запрос упал,
  // id лёг в очередь повторов. Повтор идёт при запуске приложения.
  await seed(page, { sub: true, retry: ['a'] });

  await expect.poll(() => calls.filter((c) => c.path === '/schedule').map((c) => c.taskId)).toContain('a');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('life-hub-reminder-retry')))
    .toBeNull();
});
