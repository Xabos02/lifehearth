// Состояние семейных пространств: ключ, токен, курсор lastSeq — по одной
// строке на группу (первичный ключ = familyId). Отдельная Dexie-таблица family
// (изолирована от личного sync). НЕ синкается, НЕ в бэкап.

import { db } from '../../db/db';
import type { FamilyConfig } from '../../db/types';

export async function getFamilyConfig(familyId: string): Promise<FamilyConfig | undefined> {
  return db.family.get(familyId);
}

/** Все семейные группы пользователя. Порядок — по sortOrder (перестановка в
 *  «Управлении группами»), у кого его нет — в хвост по joinedAt. */
export async function listFamilyConfigs(): Promise<FamilyConfig[]> {
  const all = await db.family.toArray();
  const so = (c: FamilyConfig) => c.sortOrder ?? Number.MAX_SAFE_INTEGER;
  return all.sort((a, b) => so(a) - so(b) || a.joinedAt.localeCompare(b.joinedAt));
}

/** Зафиксировать новый порядок групп: sortOrder = позиция в списке. */
export async function reorderFamilies(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.family, async () => {
    for (let i = 0; i < orderedIds.length; i++) {
      const c = await db.family.get(orderedIds[i]);
      if (c) await db.family.put({ ...c, sortOrder: i });
    }
  });
}

export async function saveFamilyConfig(c: FamilyConfig): Promise<void> {
  await db.family.put(c);
}

export async function patchFamilyConfig(familyId: string, p: Partial<Omit<FamilyConfig, 'id' | 'familyId'>>): Promise<void> {
  const cur = await getFamilyConfig(familyId);
  if (!cur) return;
  await db.family.put({ ...cur, ...p });
}

/** Выход из одной группы: убираем её конфиг и её локальные данные (на
 *  сервере остаются). Другие группы не трогаем. */
export async function clearFamily(familyId: string): Promise<void> {
  await db.transaction('rw', [db.family, db.familyMembers, db.familyTasks, db.familyMessages, db.settings], async () => {
    await db.family.delete(familyId);
    // Без пометки синк при чтении с нуля завёл бы группу обратно.
    const s = await db.settings.get('app');
    if (s) await db.settings.put({ ...s, leftFamilies: { ...s.leftFamilies, [familyId]: new Date().toISOString() } });
    await db.familyMembers.where('familyId').equals(familyId).delete();
    await db.familyTasks.where('familyId').equals(familyId).delete();
    await db.familyMessages.where('familyId').equals(familyId).delete();
  });
}

/** Есть ли хотя бы одна включённая группа. */
export async function hasAnyFamily(): Promise<boolean> {
  const all = await db.family.toArray();
  return all.some((c) => c.enabled);
}
