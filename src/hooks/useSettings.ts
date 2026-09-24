import { useLiveQuery } from 'dexie-react-hooks';
import { db, DEFAULT_SETTINGS } from '../db/db';
import type { Settings } from '../db/types';
import { now } from '../db/repo';

export function useSettings(): Settings {
  return useLiveQuery(() => db.settings.get('app'), []) ?? DEFAULT_SETTINGS;
}

export async function updateSettings(
  changes: Partial<Omit<Settings, 'id'>>,
): Promise<void> {
  await db.settings.update('app', { ...changes, updatedAt: now() });
  // Пол решает, существуют ли «Женские дни», а с ними и их задачи в общем
  // списке: при смене на мужской нетронутые уходят в корзину сразу. Раньше
  // они оставались — раздела нет, а «Плановый визит к врачу» висит. Импорт
  // ленивый, как в db/backup.ts: общий помощник настроек зовут отовсюду, и
  // тащить за ним модуль цикла с прогнозом в каждый импорт незачем.
  if (changes.gender !== undefined) {
    const { syncAutoTasks } = await import('../lib/cycle/cycleRepo');
    await syncAutoTasks();
  }
}
