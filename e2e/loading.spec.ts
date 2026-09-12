import { test, expect, openApp } from './fixtures';

// Пустое состояние не должно мелькать до того, как пришли данные.
//
// Дефект был массовым: `useLiveQuery(...) ?? []` склеивает «Dexie ещё не
// ответил» (undefined) и «записей нет» ([]), поэтому на первом кадре рисовалась
// заглушка «пока ничего нет». На чате и статистике она занимает весь экран, и
// человек с полным приложением видел вспышку пустоты при каждом заходе.
//
// Ловится это только в движке и только с задержкой: на быстрой машине Dexie
// отвечает за миллисекунды, и глазами вспышку не поймать. Поэтому здесь
// замедляется CPU — тогда первый кадр живёт достаточно долго, чтобы его
// увидеть.

const EMPTY_TEXTS = [
  'Пока нет задач',
  'На сегодня задач нет',
  'Пока нет данных',
  'Пока нет сообщений',
  'Пока нет заметок',
  'Пока нет трат и доходов',
  'Пока нет привычек',
  'Пока ничего нет',
  'Пока нет способов',
  'Пока пусто',
  'Первая тренировка',
];

const SCREENS = [
  ['/', 'Сегодня'],
  ['/tasks', 'Задачи'],
  ['/notes', 'Заметки'],
  ['/stats', 'Статистика'],
  ['/more/finance', 'Финансы'],
  ['/more/habits', 'Привычки'],
  ['/more/energy', 'Энергия'],
  ['/more/learning', 'Обучение'],
  ['/more/health', 'Здоровье'],
] as const;

for (const [path, title] of SCREENS) {
  test(`${title}: пустое состояние не мигает при загрузке`, async ({ page }) => {
    // Данные засеваем так, чтобы экран заведомо БЫЛ непустым: только тогда
    // всплывшая заглушка — доказанная ложь, а не законное «ничего нет».
    await openApp(page);
    await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      const now = new Date().toISOString();
      const today = now.slice(0, 10);
      const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
      await db.tasks.put({
        ...base('t-load'), title: 'Задача для проверки загрузки', notes: '', projectId: null,
        goalId: null, priority: 0, dueDate: today, dueTime: null, duration: null,
        remindBefore: null, completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: 1,
      });
      await db.notes.put({ ...base('n-load'), title: 'Заметка', content: '', tags: [], pinned: false });
      await db.expenseItems.put({
        ...base('e-load'), title: 'Аренда', amount: 1000, kind: 'expense', category: 'Жильё',
        recurrence: 'monthly', dayOfMonth: 1, notes: '', active: true, sortOrder: 1,
      });
      await db.habits.put({
        ...base('h-load'), name: 'Привычка', emoji: '🏃', color: '#888',
        schedule: { type: 'daily' }, target: null, unit: '', goalId: null, archivedAt: null, sortOrder: 1,
      });
      await db.energyItems.put({
        ...base('en-load'), title: 'Прогулка', description: '', category: 'Тело',
        effectiveness: 5, effort: 'low', sortOrder: 1,
      });
      await db.learningItems.put({
        ...base('l-load'), title: 'Книга', author: '', kind: 'book', status: 'inProgress',
        goalId: null, progressUnit: 'percent', progressTarget: 100, progressCurrent: 10,
        notes: '', startedAt: null, finishedAt: null,
      });
      await db.workouts.put({
        ...base('w-load'), date: today, type: 'run', minutes: 30, distanceKm: 5, effort: null, note: '', source: 'manual',
      });
    });

    // Замедляем процессор: без этого первый кадр не поймать.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });

    const seen: string[] = [];
    // Снимаем текст с самого раннего момента и до появления содержимого.
    await page.goto(path);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const text = await page.locator('#root').innerText().catch(() => '');
      for (const t of EMPTY_TEXTS) if (text.includes(t) && !seen.includes(t)) seen.push(t);
      if (text.includes('Задача для проверки загрузки') || seen.length > 0) break;
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    expect(seen, `на ${path} мелькнула заглушка, хотя данные есть`).toEqual([]);
    await expect(page.locator('h1').first()).toHaveText(new RegExp(title, 'i'));
  });
}
