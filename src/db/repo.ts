import type { Table, UpdateSpec } from 'dexie';
import type { BaseEntity } from './types';
import { scheduleSyncSoon } from '../lib/sync';

// Единственная точка записи в БД. UI-код не вызывает Dexie-методы записи
// напрямую — это гарантирует sync-ready штампы (id/updatedAt/deletedAt)
// и единый триггер мгновенной синхронизации после правок. (Применение
// входящих записей при pull идёт мимо repo — напрямую в Dexie — поэтому
// синк не зацикливается.)

export function now(): string {
  return new Date().toISOString();
}

export function uid(): string {
  return crypto.randomUUID();
}

export async function create<T extends BaseEntity>(
  table: Table<T, string>,
  data: Omit<T, keyof BaseEntity>,
): Promise<T> {
  const ts = now();
  const entity = {
    ...data,
    id: uid(),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
  } as T;
  await table.add(entity);
  scheduleSyncSoon();
  return entity;
}

/** Создать запись с ЗАДАННЫМ id.
 *
 *  Обычный create выдаёт случайный идентификатор, и для большинства записей это
 *  правильно. Но у кусков вложения id обязан считаться из содержимого: два
 *  устройства перекладывают одну и ту же задачу в новый формат независимо друг
 *  от друга, и со случайными идентификаторами получились бы два комплекта одних
 *  и тех же снимков — оба уехали бы на сервер и остались там навсегда.
 *
 *  put, а не add: повторное перекладывание той же задачи (второе устройство,
 *  повторный запуск после обрыва) обязано быть безобидным, а не падать. */
export async function createWithId<T extends BaseEntity>(
  table: Table<T, string>,
  id: string,
  data: Omit<T, keyof BaseEntity>,
): Promise<T> {
  const ts = now();
  const entity = { ...data, id, createdAt: ts, updatedAt: ts, deletedAt: null } as T;
  await table.put(entity);
  scheduleSyncSoon();
  return entity;
}

export async function update<T extends BaseEntity>(
  table: Table<T, string>,
  id: string,
  changes: Partial<Omit<T, 'id' | 'createdAt'>>,
): Promise<void> {
  await table.update(id, { ...changes, updatedAt: now() } as UpdateSpec<T>);
  scheduleSyncSoon();
}

/** Несколько правок одной транзакцией — для перестановок, где меняется
 *  sortOrder у половины списка. По одной их писать нельзя: убитая между
 *  записями вкладка (iOS сворачивает приложение сразу после жеста) оставляла
 *  половину задач с новым порядком, половину со старым, и список после синка
 *  собирался не так, как человек его видел. Один updatedAt на всех и один
 *  вызов синка. */
export async function updateMany<T extends BaseEntity>(
  table: Table<T, string>,
  items: ReadonlyArray<{ id: string; changes: Partial<Omit<T, 'id' | 'createdAt'>> }>,
): Promise<void> {
  if (items.length === 0) return;
  const ts = now();
  await table.bulkUpdate(items.map(({ id, changes }) => ({ key: id, changes: { ...changes, updatedAt: ts } as UpdateSpec<T> })));
  scheduleSyncSoon();
}

/** Мягкое удаление: запись скрывается из UI, но остаётся для будущего синка. */
export async function remove<T extends BaseEntity>(
  table: Table<T, string>,
  id: string,
): Promise<void> {
  await table.update(id, { deletedAt: now(), updatedAt: now() } as unknown as UpdateSpec<T>);
  scheduleSyncSoon();
}

/** Фильтр живых записей — применять после каждого чтения списком. */
export function alive<T extends BaseEntity>(rows: T[]): T[] {
  return rows.filter((r) => !r.deletedAt);
}
