// Приватность раздела «Женские дни» в резервных копиях.
//
// Настройка «включать раздел в копию» — единственное место, где человек сам
// решает, что уходит в облако. Раз так, она обязана переживать восстановление:
// настройка, которая сама себя отменяет, хуже отсутствующей — человек считает,
// что раздел закрыт, а он открыт.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

const { db } = await import('./db');
const { exportBackup, importBackup, cycleBackupLocked } = await import('./backup');

const PRIVATE_SETTINGS = {
  id: 'app',
  lock: 'pin' as const,
  pin: 'хеш-кода',
  hideFromNavigation: true,
  includeInGeneralBackup: false,
};

async function seed() {
  await db.cycleSettings.put(PRIVATE_SETTINGS as never);
  await db.cycleDays.bulkPut([
    { date: '2026-01-01', bleeding: 'medium' },
    { date: '2026-01-02', bleeding: 'light' },
  ] as never[]);
  await db.cycleSymptoms.put({ key: 'свой', group: 'other', label: 'свой симптом' } as never);
}

describe('раздел «Женские дни» в копии', () => {
  beforeEach(async () => {
    await Promise.all([
      db.cycleSettings.clear(),
      db.cycleDays.clear(),
      db.cycleSymptoms.clear(),
      db.notes.clear(),
    ]);
    await seed();
  });

  it('выключенный раздел не кладёт в копию свои ДАННЫЕ', async () => {
    const file = await exportBackup();
    expect(file.data.cycleDays).toEqual([]);
  });

  it('выключенный раздел не кладёт в копию и НАСТРОЙКИ — ключа нет вовсе', async () => {
    // Именно ключа, а не пустого массива. Пустой массив importBackup понимает
    // как «очистить таблицу», и настройки стёрлись бы вместе с данными.
    const file = await exportBackup();
    expect('cycleSettings' in file.data).toBe(false);
    expect('cycleSymptoms' in file.data).toBe(false);
  });

  it('восстановление НЕ сбрасывает код доступа и настройку приватности', async () => {
    // Тот самый сценарий: человек запаролил раздел, спрятал из меню и выключил
    // из копий. Раньше любое восстановление стирало строку настроек, а раздел
    // заводил её заново с умолчаниями — без кода, снова в меню и снова в
    // облаке. Самоотменяющаяся приватность.
    const file = await exportBackup();
    await importBackup(file);

    const after = await db.cycleSettings.get('app');
    expect(after).toBeDefined();
    expect(after!.lock).toBe('pin');
    expect(after!.pin).toBe('хеш-кода');
    expect(after!.hideFromNavigation).toBe(true);
    expect(after!.includeInGeneralBackup).toBe(false);
  });

  it('свой симптом переживает восстановление', async () => {
    const file = await exportBackup();
    await importBackup(file);
    expect(await db.cycleSymptoms.get('свой')).toBeDefined();
  });

  it('данные раздела при этом действительно очищаются — так и задумано', async () => {
    // Обратная сторона той же настройки, и она НЕ дефект: «выключил и
    // восстановился» должно очищать раздел, иначе старые записи пережили бы
    // восстановление вопреки ожиданию. Тест держит границу между двумя
    // половинами, чтобы починка одной не поехала в другую.
    const file = await exportBackup();
    await importBackup(file);
    expect(await db.cycleDays.count()).toBe(0);
  });

  it('включённый раздел кладёт в копию всё, включая настройки', async () => {
    // Код раздела этого не меняет: облачная копия зашифрована ключом
    // синхронизации, а копию файлом закрывает окно кода в BackupPage
    // (e2e/backup-pin.spec.ts). Здесь — то, что уходит в облако.
    await db.cycleSettings.put({ ...PRIVATE_SETTINGS, includeInGeneralBackup: true } as never);
    const file = await exportBackup();
    expect(file.data.cycleDays).toHaveLength(2);
    expect(file.data.cycleSettings).toHaveLength(1);
  });
});

// ST4 аудита 1.64.0: код на разделе обходился «Сохранить в файл». Кто код не
// знает, сохраняет копию без раздела — и она не должна стирать историю цикла
// при восстановлении.
describe('копия файлом без «Женских дней»', () => {
  const CYCLE_KEYS = ['cycleDays', 'cycleOverrides', 'cycleEpisodes', 'cycleSettings', 'cycleSymptoms', 'cyclePredictions'];

  beforeEach(async () => {
    await Promise.all([db.cycleSettings.clear(), db.cycleDays.clear(), db.cycleSymptoms.clear()]);
    await seed();
    await db.cycleSettings.put({ ...PRIVATE_SETTINGS, includeInGeneralBackup: true } as never);
  });

  it('ключей раздела в файле нет вовсе — ни данных, ни настроек', async () => {
    const file = await exportBackup({ withoutCycle: true });
    for (const k of CYCLE_KEYS) expect(k in file.data, k).toBe(false);
    expect(Array.isArray(file.data.notes)).toBe(true);
  });

  it('восстановление такой копии историю цикла и код не трогает', async () => {
    // Пустые массивы вместо пропуска ключей стёрли бы оба дня и строку
    // настроек: importBackup очищает таблицу, для которой в файле есть список.
    const file = await exportBackup({ withoutCycle: true });
    await importBackup(file);
    expect(await db.cycleDays.count()).toBe(2);
    expect((await db.cycleSettings.get('app'))?.pin).toBe('хеш-кода');
  });

  it('код для копии нужен, только когда раздел закрыт и входит в копию', async () => {
    expect(await cycleBackupLocked()).toBe(true);
    await db.cycleSettings.put({ ...PRIVATE_SETTINGS, includeInGeneralBackup: false } as never);
    expect(await cycleBackupLocked()).toBe(false);
    await db.cycleSettings.put({ ...PRIVATE_SETTINGS, lock: 'none', pin: undefined, includeInGeneralBackup: true } as never);
    expect(await cycleBackupLocked()).toBe(false);
  });
});
