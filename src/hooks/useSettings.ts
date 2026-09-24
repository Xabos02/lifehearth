import { useLiveQuery } from 'dexie-react-hooks';
import { db, DEFAULT_SETTINGS } from '../db/db';
import type { Settings } from '../db/types';
import { now } from '../db/repo';
import { syncAutoTasks } from '../lib/cycle/cycleRepo';

export function useSettings(): Settings {
  return useLiveQuery(() => db.settings.get('app'), []) ?? DEFAULT_SETTINGS;
}

export async function updateSettings(
  changes: Partial<Omit<Settings, 'id'>>,
): Promise<void> {
  await db.settings.update('app', { ...changes, updatedAt: now() });
  // Пол решает, существуют ли «Женские дни», а с ними и их задачи в общем
  // списке: при смене на мужской нетронутые уходят в корзину сразу. Раньше
  // они оставались — раздела нет, а «Плановый визит к врачу» висит. Сбой
  // пересчёта глушим, как в rebuildCycles: пол уже записан, и отклонять его
  // сохранение из-за задач незачем — они останутся как были до следующего
  // пересчёта.
  if (changes.gender !== undefined) {
    try {
      await syncAutoTasks();
    } catch {
      /* автозадачи подождут следующего пересчёта */
    }
  }
}
