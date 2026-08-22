import { useEffect } from 'react';
import { runSync } from '../lib/sync';
import { retryPendingReminders } from '../lib/push';
import { db } from '../db/db';

const INTERVAL_MS = 60_000;

/** Запускает синхронизацию при старте, возврате в приложение и периодически.
 *  runSync сам выходит, если синк не настроен/выключен (или уже идёт). */
export function SyncRunner() {
  useEffect(() => {
    const sync = () => {
      if (document.visibilityState !== 'visible') return;
      void runSync().catch(() => {});
      // Заодно — напоминания, которые не удалось поставить раньше. Задачу
      // заводят на ходу, там же чаще всего и пропадает сеть, а повторить
      // попытку было некому: напоминание просто не срабатывало.
      void retryPendingReminders(async (ids) => {
        const rows = await db.tasks.bulkGet(ids);
        return rows
          .filter((t): t is NonNullable<typeof t> => Boolean(t) && !t!.deletedAt && !t!.completedAt)
          .map((t) => ({
            id: t.id,
            title: t.title,
            dueDate: t.dueDate ?? null,
            dueTime: t.dueTime ?? null,
            remindBefore: t.remindBefore ?? null,
          }));
      }).catch(() => {});
    };
    sync(); // при запуске
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    const id = setInterval(sync, INTERVAL_MS);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      clearInterval(id);
    };
  }, []);
  return null;
}
