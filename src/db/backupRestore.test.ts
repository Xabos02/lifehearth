// Что происходит с синхронизацией после восстановления из копии.
//
// Восстановление стирает таблицы и кладёт строки из снапшота с их исходными
// временами. Если курсоры обмена оставить на месте, всё, что появилось после
// снятия копии, на это устройство не вернётся никогда — сервер отдаёт только
// то, что новее курсора. А восстановленные строки старше lastPushAt и не
// уедут на второе устройство.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import { importBackup, exportBackup } from './backup';
import { getSyncConfig } from '../lib/syncState';
import { generateKey } from '../lib/crypto';

async function seedSyncConfig(cursors: { lastPullAt: string; lastPushAt: string; lastPullSeq?: number; deviceId?: string }) {
  await db.sync.put({
    id: 'config',
    accountId: 'acc-1',
    authToken: 'tok-1',
    key: await generateKey(),
    enabled: true,
    lastSyncedAt: '2026-08-20T10:00:00.000Z',
    ...cursors,
  } as never);
}

describe('восстановление из копии и синхронизация', () => {
  beforeEach(async () => {
    await db.open();
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it('сбрасывает оба курсора — иначе данные после снапшота теряются навсегда', async () => {
    await seedSyncConfig({
      deviceId: 'dev-old',
      lastPullSeq: 417,
      lastPullAt: '2026-08-20T10:00:00.000Z|x',
      lastPushAt: '2026-08-20T10:00:00.000Z',
    });
    const backup = await exportBackup();

    await importBackup(backup);

    const c = await getSyncConfig();
    expect(c?.lastPullSeq).toBe(0);
    expect(c?.lastPullAt).toBe('');
    expect(c?.lastPushAt).toBe('');
    // И имя устройства новое: сервер не отдаёт устройству его же записи, а
    // после восстановления старой копии их-то и нет.
    expect(c?.deviceId).toBeTruthy();
    expect(c?.deviceId).not.toBe('dev-old');
    // Остальное в настройках обмена не тронуто — устройство остаётся
    // подключённым к тому же аккаунту.
    expect(c?.accountId).toBe('acc-1');
    expect(c?.enabled).toBe(true);
  });

  it('без настроенной синхронизации восстановление проходит как обычно', async () => {
    const backup = await exportBackup();
    await expect(importBackup(backup)).resolves.toBeUndefined();
    expect(await getSyncConfig()).toBeUndefined();
  });

  it('данные из копии на месте — сброс курсоров ничего не сломал', async () => {
    await db.tasks.put({
      id: 't1', title: 'Забрать колёса', done: false,
      createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-19T10:00:00.000Z', deletedAt: null,
    } as never);
    const backup = await exportBackup();
    await db.tasks.clear();
    await seedSyncConfig({ lastPullAt: 'x', lastPushAt: 'y' });

    await importBackup(backup);

    expect((await db.tasks.get('t1'))?.title).toBe('Забрать колёса');
  });
});

describe('восстановление и куски вложений', () => {
  beforeEach(async () => {
    await db.open();
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it('пустой список кусков в копии не стирает то, что есть на устройстве', async () => {
    // Куски приезжают синком отдельно от своих записей. Копия, снятая
    // устройством, до которого они не доехали, содержит пустой список — и
    // очистка по нему стёрла бы фотографии, которые на этом устройстве есть.
    await db.taskPhotos.put({
      id: 'p_0', taskId: 't1', photoId: 'p', idx: 0, total: 1, data: 'кусок',
      createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z', deletedAt: null,
    } as never);
    const backup = await exportBackup();
    // Копия снята другим устройством: снимков там ещё нет.
    (backup.data as Record<string, unknown[]>).taskPhotos = [];

    await importBackup(backup);

    expect(await db.taskPhotos.get('p_0')).toBeTruthy();
  });

  it('непустой список кусков в копии применяется как обычно', async () => {
    const backup = await exportBackup();
    (backup.data as Record<string, unknown[]>).taskPhotos = [
      {
        id: 'from_backup', taskId: 't9', photoId: 'q', idx: 0, total: 1, data: 'из копии',
        createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z', deletedAt: null,
      },
    ];
    await importBackup(backup);
    expect((await db.taskPhotos.get('from_backup'))?.data).toBe('из копии');
  });
});
