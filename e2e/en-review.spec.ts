import type { Page } from '@playwright/test';
import { openApp, openFamilyChrome, test, expect } from './fixtures';
import { addDaysKey, todayKey } from '../src/lib/dates';

// ВРЕМЕННЫЙ спек EN-скриншот-ревью. Не для постоянного набора: снимает каждый
// экран приложения в английском интерфейсе, чтобы глазами выловить кривые
// формулировки и вёрстку, не пережившую более длинный английский текст.
// Скриншоты складываются в каталог из EN_SHOTS_DIR (по умолчанию ./en-shots).

const OUT = process.env.EN_SHOTS_DIR || 'en-shots';

// Скриншот-туры длинные: один тест обходит до десятка экранов с двумя кадрами
// на каждом — штатных 30 секунд на медленном контейнере не хватает.
test.setTimeout(90_000);

async function shot(page: Page, name: string, opts: { full?: boolean } = {}) {
  await page.waitForTimeout(350); // дать анимациям шитов/переходов осесть
  await page.screenshot({ path: `${OUT}/${name}.png` });
  if (opts.full) {
    await page.screenshot({ path: `${OUT}/${name}-full.png`, fullPage: true });
  }
}

/** Общие данные: задачи, проекты, заметки, привычки, цели и прочее. */
async function seedCore(page: Page) {
  await page.evaluate(
    async ({ today, yest, plus3, minus2 }) => {
      const { db } = await import('/src/db/db.ts');
      const now = new Date().toISOString();
      const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
      const task = (id: string, over: Record<string, unknown>) => ({
        ...base(id), title: '', notes: '', projectId: null, goalId: null, priority: 0 as const,
        dueDate: null, dueTime: null, duration: null, remindBefore: null, completedAt: null,
        checklist: [], recurrence: null, tags: [], sortOrder: 0, ...over,
      });
      await db.projects.bulkPut([
        { ...base('p1'), name: 'Home renovation', color: '#5b7cfa', emoji: '🏠', sortOrder: 0, archivedAt: null, parentId: null },
        { ...base('p2'), name: 'Kitchen', color: '#5b7cfa', emoji: '🍳', sortOrder: 0, archivedAt: null, parentId: 'p1' },
      ]);
      await db.tasks.bulkPut([
        task('t1', { title: 'Pick up the parcel from the post office', dueDate: today, dueTime: '18:30', remindBefore: 30, priority: 2, projectId: 'p1', sortOrder: 0 }),
        task('t2', { title: 'Call the plumber about the leaking tap', dueDate: yest, priority: 3, projectId: 'p1', sortOrder: 1 }),
        task('t3', { title: 'Prepare the quarterly report', startDate: minus2, dueDate: plus3, sortOrder: 2, checklist: [
          { id: 'c1', text: 'Collect the numbers', done: true },
          { id: 'c2', text: 'Draft the summary', done: false },
        ] }),
        task('t4', { title: 'Water the plants', recurrence: { type: 'daily', interval: 1 }, dueDate: today, sortOrder: 3 }),
        task('t5', { title: 'Book a table for Friday', completedAt: now, dueDate: today, sortOrder: 4 }),
        task('t6', { title: 'Learn to play the guitar', frozenAt: now, sortOrder: 5 }),
        task('t7', { title: 'Old deleted task', deletedAt: now, sortOrder: 6 }),
      ]);
      await db.noteFolders.bulkPut([
        { ...base('nf1'), name: 'Ideas', emoji: '💡', color: '#5b7cfa', sortOrder: 0, parentId: null },
      ]);
      await db.notes.bulkPut([
        { ...base('n1'), title: 'Grocery list for the week', content: '<p>Milk, eggs, bread, coffee beans</p>', tags: [], pinned: true, folderId: null },
        { ...base('n2'), title: 'Thoughts on the next trip', content: '<p>Compare flights to Lisbon and Porto</p>', tags: [], pinned: false, folderId: 'nf1' },
        { ...base('n3'), title: 'Deleted note', content: '<p>gone</p>', tags: [], pinned: false, deletedAt: now },
      ]);
      await db.habits.bulkPut([
        { ...base('h1'), name: 'Morning run', emoji: '🏃', color: '#5b7cfa', schedule: { type: 'daily' }, target: 5, unit: 'km', goalId: null, archivedAt: null, sortOrder: 0 },
        { ...base('h2'), name: 'Read before bed', emoji: '📖', color: '#22c55e', schedule: { type: 'weekdays', weekdays: [1, 2, 3, 4, 5] }, target: null, unit: '', goalId: null, archivedAt: null, sortOrder: 1 },
      ]);
      const logs: unknown[] = [];
      for (let i = 1; i <= 5; i++) {
        logs.push({ ...base(`hl${i}`), habitId: 'h1', date: addDays(today, -i), value: 5 });
        logs.push({ ...base(`hl${i}b`), habitId: 'h2', date: addDays(today, -i), value: null });
      }
      await db.habitLogs.bulkPut(logs as never[]);
      function addDays(key: string, n: number) {
        const d = new Date(`${key}T12:00:00`);
        d.setDate(d.getDate() + n);
        return d.toISOString().slice(0, 10);
      }
      await db.goals.bulkPut([
        { ...base('g1'), title: 'Run a half marathon', description: 'Train three times a week', targetDate: plus3, status: 'active', progressMode: 'manual', progressManual: 40, targetValue: null, currentValue: null, unitLabel: '', color: '#5b7cfa', sortOrder: 0 },
        { ...base('g2'), title: 'Read 24 books this year', description: '', targetDate: null, status: 'active', progressMode: 'numeric', progressManual: 0, targetValue: 24, currentValue: 9, unitLabel: 'books', color: '#22c55e', sortOrder: 1 },
      ]);
      await db.learningItems.bulkPut([
        { ...base('l1'), title: 'Deep Work', author: 'Cal Newport', kind: 'book', status: 'inProgress', goalId: 'g2', progressUnit: 'pages', progressTarget: 300, progressCurrent: 120, notes: '', startedAt: now, finishedAt: null },
        { ...base('l2'), title: 'Spanish', author: '', kind: 'language', status: 'planned', goalId: null, progressUnit: 'percent', progressTarget: 100, progressCurrent: 0, notes: '', startedAt: null, finishedAt: null },
      ]);
      await db.expenseItems.bulkPut([
        { ...base('e1'), title: 'Rent', amount: 45000, kind: 'expense', category: 'Жильё', recurrence: 'monthly', dayOfMonth: 5, notes: '', active: true, sortOrder: 0 },
        { ...base('e2'), title: 'Salary', amount: 120000, kind: 'income', category: 'Работа', recurrence: 'monthly', dayOfMonth: 10, notes: '', active: true, sortOrder: 1 },
        { ...base('e3'), title: 'Music subscription', amount: 299, kind: 'expense', category: 'Подписки', recurrence: 'monthly', dayOfMonth: 1, notes: '', active: true, sortOrder: 2 },
      ]);
      await db.savingsGoals.bulkPut([
        { ...base('s1'), title: 'New laptop', emoji: '💻', color: '#5b7cfa', targetAmount: 150000, targetDate: plus3, note: '', archivedAt: null, sortOrder: 0 },
      ]);
      await db.savingsDeposits.bulkPut([
        { ...base('sd1'), goalId: 's1', amount: 40000, date: yest, note: '' },
      ]);
      await db.energyLogs.bulkPut([
        { ...base('el1'), date: today, level: 4 },
        { ...base('el2'), date: yest, level: 3 },
        { ...base('el3'), date: minus2, level: 2 },
      ]);
      await db.energyItems.bulkPut([
        { ...base('ei1'), title: 'Walk in the park', description: 'Half an hour without the phone', category: 'Природа', effectiveness: 5, effort: 'low', sortOrder: 0 },
        { ...base('ei2'), title: 'Boxing session', description: '', category: 'Тело', effectiveness: 4, effort: 'high', sortOrder: 1 },
      ]);
      await db.placeItems.bulkPut([
        { ...base('pl1'), title: 'Trattoria on the corner', kind: 'food', description: 'Great carbonara, ask for the terrace', source: 'Anna', location: 'Rome', link: '', photo: null, tags: [], status: 'want', sortOrder: 0 },
        { ...base('pl2'), title: 'Museum of modern art', kind: 'place', description: '', source: '', location: '', link: '', photo: null, tags: [], status: 'done', sortOrder: 1 },
      ]);
      await db.reminderSections.bulkPut([
        { ...base('rs1'), title: 'Work', collapsed: false, sortOrder: 0 },
      ]);
      await db.reminderItems.bulkPut([
        { ...base('ri1'), sectionId: 'rs1', text: 'Badge, keys, water bottle', sortOrder: 0 },
      ]);
      const prev = (await db.settings.get('app')) ?? { id: 'app' };
      await db.settings.put({
        ...prev,
        profile: { name: 'Anna', birthDate: '1998-06-29', heightCm: 170, weightKg: 60 },
      });
    },
    {
      today: todayKey(),
      yest: addDaysKey(todayKey(), -1),
      plus3: addDaysKey(todayKey(), 3),
      minus2: addDaysKey(todayKey(), -2),
    },
  );
}

/** Семья: группа, участники, переписка — локально, без сети. */
async function seedFamily(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    await db.family.put({
      id: 'f1', familyId: 'f1', familyToken: 't', familyKey: key, familyName: 'Our family',
      selfMemberId: 'me', lastSeq: 0, lastReadSeq: 0, enabled: true,
      joinedAt: new Date().toISOString(), keyEpoch: 0, keyRing: { '0': key },
    });
    const mk = (id: string, name: string, color: string) => ({
      id, familyId: 'f1', seq: 1, displayName: name, color,
      joinedAt: new Date().toISOString(), leftAt: null, removedAt: null,
    });
    await db.familyMembers.bulkPut([mk('me', 'Anna', '#5b7cfa'), mk('m1', 'Dad', '#22c55e'), mk('m2', 'Mom', '#f59e0b')]);
    const msg = (id: string, seq: number, sender: string, text: string, over: Record<string, unknown> = {}) => ({
      clientMsgId: id, familyId: 'f1', seq, senderMemberId: sender,
      createdAt: new Date(Date.now() - (100 - seq) * 60000).toISOString(),
      text, status: 'acked', deletedAt: null, ...over,
    });
    await db.familyMessages.bulkPut([
      msg('fm1', 1, 'm1', 'Dad присоединился к семье', { system: true }),
      msg('fm2', 2, 'm1', 'Are we still on for dinner on Saturday?'),
      msg('fm3', 3, 'me', 'Yes! I will book the table', { replyTo: { id: 'fm2', name: 'Dad', text: 'Are we still on for dinner on Saturday?' } }),
      msg('fm4', 4, 'm2', 'Bring the board game please 🙂'),
      msg('fm5', 5, 'me', '', { reaction: { targetId: 'fm4', emoji: '👍' } }),
    ]);
    await db.familyTasks.bulkPut([
      { id: 'ft1', familyId: 'f1', seq: 6, title: 'Buy groceries for the weekend', notes: '', priority: 1, dueDate: null, assigneeId: 'm1', createdBy: 'me', completedAt: null, completedBy: null, sortOrder: 0, deletedAt: null },
      { id: 'ft2', familyId: 'f1', seq: 7, title: 'Fix the shelf in the hallway', notes: '', priority: 0, dueDate: null, assigneeId: null, createdBy: 'm1', completedAt: new Date().toISOString(), completedBy: 'me', sortOrder: 1, deletedAt: null },
    ]);
  });
}

/** Цикл: штатный путь — ensureCycleSetup + отметки дней, циклы пересчитает repo. */
async function seedCycle(page: Page) {
  await page.evaluate(async ({ today }) => {
    const repo = await import('/src/lib/cycle/cycleRepo.ts');
    function addDays(key: string, n: number) {
      const d = new Date(`${key}T12:00:00`);
      d.setDate(d.getDate() + n);
      return d.toISOString().slice(0, 10);
    }
    await repo.ensureCycleSetup();
    await repo.updateCycleSettings({ ageBand: '26_41' });
    for (const start of [-66, -38, -10]) {
      for (let i = 0; i < 5; i++) {
        await repo.putDay(addDays(today, start + i), { bleeding: i < 3 ? 'medium' : 'light' });
      }
    }
  }, { today: todayKey() });
}

test('EN: главные экраны — сегодня, задачи, заметки, календарь', async ({ page }) => {
  await openApp(page, '/', { language: 'en' });
  await seedCore(page);
  await openApp(page, '/', { language: 'en' });
  await shot(page, '01-today', { full: true });

  await openApp(page, '/tasks', { language: 'en' });
  await shot(page, '02-tasks', { full: true });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New task' })).toBeVisible();
  await shot(page, '03-task-new-sheet', { full: true });
  await page.getByRole('button', { name: 'Close' }).click();

  // Редактирование наполненной задачи (период + чеклист).
  await page.getByText('Prepare the quarterly report').click();
  await shot(page, '04-task-edit-sheet', { full: true });
  await page.getByRole('button', { name: 'Close' }).click();

  await openApp(page, '/notes', { language: 'en' });
  await shot(page, '05-notes', { full: true });
  await page.getByRole('button', { name: 'New folder' }).click();
  await shot(page, '06-folder-sheet');
  await page.getByRole('button', { name: 'Close' }).click();

  await openApp(page, '/notes/new', { language: 'en' });
  await page.locator('.note-editor').click();
  await shot(page, '07-note-editor');
  await page.getByRole('button', { name: 'Format' }).click();
  await shot(page, '08-note-editor-format');

  await openApp(page, '/calendar', { language: 'en' });
  await shot(page, '09-calendar', { full: true });

  await openApp(page, '/more/trash', { language: 'en' });
  await shot(page, '10-trash', { full: true });

  await openApp(page, '/search', { language: 'en' });
  await shot(page, '11-search-empty');
  await page.getByRole('textbox').fill('the');
  await page.waitForTimeout(600);
  await shot(page, '12-search-results', { full: true });
});

test('EN: разделы — главная, профиль, цели, привычки, фокус, финансы, энергия, обучение, места, статистика, захват', async ({ page }) => {
  await openApp(page, '/', { language: 'en' });
  await seedCore(page);

  await openApp(page, '/home', { language: 'en' });
  await shot(page, '13-home', { full: true });

  await openApp(page, '/home/profile', { language: 'en' });
  await shot(page, '14-profile', { full: true });

  await openApp(page, '/goals', { language: 'en' });
  await shot(page, '15-goals', { full: true });
  await page.getByText('Run a half marathon').click();
  await shot(page, '16-goal-detail', { full: true });

  await openApp(page, '/more/habits', { language: 'en' });
  await shot(page, '17-habits', { full: true });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await shot(page, '18-habit-sheet', { full: true });
  await page.getByRole('button', { name: 'Close' }).click();

  await openApp(page, '/more/focus', { language: 'en' });
  await shot(page, '19-focus', { full: true });

  await openApp(page, '/more/finance', { language: 'en' });
  await shot(page, '20-finance', { full: true });

  await openApp(page, '/more/energy', { language: 'en' });
  await shot(page, '21-energy', { full: true });

  await openApp(page, '/more/learning', { language: 'en' });
  await shot(page, '22-learning', { full: true });

  await openApp(page, '/more/places', { language: 'en' });
  await shot(page, '23-places', { full: true });

  await openApp(page, '/stats', { language: 'en' });
  await shot(page, '24-stats', { full: true });

  await openApp(page, '/share', { language: 'en' });
  await shot(page, '25-capture', { full: true });
});

test('EN: настройки — экран, разделы, установка, что нового', async ({ page }) => {
  await openApp(page, '/more/settings', { language: 'en' });
  await shot(page, '26-settings', { full: true });

  await openApp(page, '/more/settings/sections', { language: 'en' });
  await shot(page, '27-settings-sections', { full: true });

  await openApp(page, '/more/settings/install', { language: 'en' });
  await shot(page, '28-settings-install', { full: true });

  await openApp(page, '/more/settings', { language: 'en' });
  const version = page.getByText(/What's new/i).first();
  if (await version.count()) {
    await version.click();
    await shot(page, '29-whats-new', { full: true });
  }
});

test('EN: семья — чат, задачи, участники, звонок', async ({ page }) => {
  await openApp(page, '/more/family', { language: 'en' });
  await shot(page, '30-family-onboarding', { full: true });
  await seedFamily(page);
  await page.goto('/more/family?g=f1');
  await expect(page.getByRole('heading', { name: 'Our family' })).toBeVisible();
  await openFamilyChrome(page, 'Chat');
  await page.getByRole('button', { name: 'Chat' }).click();
  await shot(page, '31-family-chat', { full: true });
  await page.getByRole('button', { name: 'Tasks' }).click();
  await shot(page, '32-family-tasks', { full: true });
  await page.getByRole('button', { name: 'Members' }).click();
  await shot(page, '33-family-members', { full: true });
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  await shot(page, '34-family-call-pick');
});

test('EN: цикл — онбординг, экран, настройки, год, отчёт', async ({ page }) => {
  await openApp(page, '/more/cycle', { language: 'en' });
  await shot(page, '35-cycle-onboarding', { full: true });
  await seedCycle(page);
  await openApp(page, '/more/cycle', { language: 'en' });
  await shot(page, '36-cycle', { full: true });
  await openApp(page, '/more/cycle/settings', { language: 'en' });
  await shot(page, '37-cycle-settings', { full: true });
  await openApp(page, '/more/cycle/year', { language: 'en' });
  await shot(page, '38-cycle-year', { full: true });
  await openApp(page, '/more/cycle/report', { language: 'en' });
  await shot(page, '39-cycle-report', { full: true });
});

test('EN: первый запуск — гейт пола и онбординг', async ({ page }) => {
  // Чистый заход: headless-браузер en-US, языка в настройках нет — гейт на EN.
  await page.goto('/');
  await expect(page.locator('#root')).not.toBeEmpty();
  await shot(page, '40-gender-gate', { full: true });

  // Онбординг-оверлей: пол выбран, тур не пройден.
  await openApp(page, '/', { language: 'en' });
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const prev = (await db.settings.get('app')) ?? { id: 'app' };
    await db.settings.put({ ...prev, onboardingDone: null });
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle').catch(() => {});
  await shot(page, '41-onboarding-overlay', { full: true });
});
