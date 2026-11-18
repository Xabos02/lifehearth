// D1 поверх настоящего SQLite (node:sqlite) для юнитов воркера: проверяется
// SQL сервера, а не мок. Схема — из migrations, как на проде.
// Такая же обёртка живёт внутри rename.test.ts (появилась раньше этого файла).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

type Row = Record<string, unknown>;

/** prepare(sql).bind(...).run()/all()/first(), batch — одной транзакцией. */
export function d1(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) as Row[] }),
    first: async () => (db.prepare(sql).get(...(args as never[])) as Row | undefined) ?? null,
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: ReturnType<typeof stmt>[]) => {
      db.exec('BEGIN');
      try {
        const out = list.map((s) => ({ meta: { changes: Number(db.prepare(s.sql).run(...(s.args as never[])).changes) } }));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

/** База в памяти со всеми миграциями воркера. */
export function sqliteDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of [
    '0001_init.sql',
    '0002_reminders.sql',
    '0003_push_subs.sql',
    '0004_app_meta.sql',
    '0005_backups.sql',
    '0006_records_pull_id.sql',
    '0007_records_seq.sql',
  ]) {
    db.exec(readFileSync(new URL(`./migrations/${f}`, import.meta.url), 'utf8'));
  }
  return db;
}
