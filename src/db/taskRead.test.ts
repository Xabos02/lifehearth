import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { db } from './db';

// Задача без полей, которые экраны читают без проверки. Так выглядит запись,
// положенная мимо форм: чужой версией через синк, правленой копией, тестом.
// До нормализации при чтении строка списка падала на task.checklist.filter
// и роняла весь экран.
it('задача без checklist/tags/notes читается полной на всех путях чтения', async () => {
  await db.open();
  await db.tasks.clear();
  const ts = '2026-08-01T10:00:00.000Z';
  await db.tasks.put({
    id: 'bare', title: 'Голая', projectId: 'p1', dueDate: '2026-08-25',
    createdAt: ts, updatedAt: ts, deletedAt: null,
  } as never);

  const reads = [
    await db.tasks.get('bare'),
    (await db.tasks.bulkGet(['bare']))[0],
    (await db.tasks.toArray())[0],
    (await db.tasks.where('dueDate').equals('2026-08-25').toArray())[0],
  ];
  for (const t of reads) {
    expect(t).toMatchObject({ checklist: [], tags: [], notes: '', duration: null, remindBefore: null });
  }
  // Несуществующий id — хук получает undefined и не должен на нём падать.
  expect(await db.tasks.get('missing')).toBeUndefined();
});
