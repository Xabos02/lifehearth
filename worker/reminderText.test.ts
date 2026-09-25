// Сервер хранит текст напоминания только шифротекстом (решение 24.09:
// «всё защищено»). Проверяется ровно то, что уходит в D1, и SQL-чистка старых
// записей — на настоящем SQLite (node:sqlite, как в familyRoom.test.ts).
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SCRUB_PLAIN_REMINDERS_SQL, storableReminderText } from './src/reminderText.js';

describe('текст напоминания на сервере', () => {
  it('шифротекст хранится как есть, открытый текст — нет', () => {
    expect(storableReminderText('', 'e2e1:abc')).toEqual({ title: '', body: 'e2e1:abc' });
    expect(storableReminderText('Забрать анализы', 'Через 30 мин')).toEqual({ title: '', body: '' });
    expect(storableReminderText(undefined, undefined)).toEqual({ title: '', body: '' });
  });

  it('чистка стирает открытый текст старых записей и не трогает шифротекст', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE reminders (task_id TEXT PRIMARY KEY, fire_at INTEGER, title TEXT, body TEXT, subscription TEXT)');
    const ins = db.prepare('INSERT INTO reminders VALUES (?, ?, ?, ?, ?)');
    ins.run('old', 1, 'Забрать анализы', 'Через 30 мин', '{}');
    ins.run('new', 1, '', 'e2e1:abc', '{}');
    db.exec(SCRUB_PLAIN_REMINDERS_SQL);
    const rows = db.prepare('SELECT task_id, title, body FROM reminders ORDER BY task_id').all();
    expect(rows).toEqual([
      { task_id: 'new', title: '', body: 'e2e1:abc' },
      { task_id: 'old', title: '', body: '' },
    ]);
  });
});
