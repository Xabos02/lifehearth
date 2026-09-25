import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import type { Settings } from '../db/types';
import { listFamilyConfigs } from '../lib/family/familyState';
import { pushEnabled, pushPaused } from '../lib/push';

/** Какое внешнее у человека уже включено — ключи EXTERNAL_LABELS.
 *
 *  Нужно окну согласия и настройкам (задача 34): обновившемуся с включённым
 *  синком или семьёй окно не даёт «Не сейчас», а называет, что встанет на
 *  паузу. undefined — ещё читаем базу: решать по неполному списку нельзя,
 *  иначе на первом кадре мелькнёт не тот вариант окна. */
export function useExternalOn(settings: Settings | undefined): (keyof typeof EXTERNAL_LABELS)[] | undefined {
  const sync = useLiveQuery(async () => Boolean((await db.sync.get('config'))?.enabled), []);
  const family = useLiveQuery(async () => (await listFamilyConfigs()).some((c) => c.enabled), []);
  if (sync === undefined || family === undefined || !settings) return undefined;
  const on: (keyof typeof EXTERNAL_LABELS)[] = [];
  if (sync) on.push('sync');
  if (family) on.push('family');
  if (pushEnabled() || pushPaused()) on.push('push');
  if (settings.aiEnabled) on.push('ai');
  return on;
}

export const EXTERNAL_LABELS = {
  sync: 'Синхронизация',
  family: 'Семья',
  push: 'Уведомления',
  ai: 'Ассистент',
} as const;
