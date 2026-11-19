// v25: разовая правка раскладки — «Женские дни» видны всем женским профилям.
// И при обновлении базы, и при восстановлении копии, снятой до v25.

import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { db, DEFAULT_SETTINGS } from './db';
import { importBackup, validateBackup } from './backup';
import type { Settings } from './types';

/** Строка настроек после обновления базы с v24 (та же схема, версия на шаг ниже). */
async function upgradeFrom24(row: Partial<Settings>): Promise<Settings | undefined> {
  db.close();
  await Dexie.delete(db.name);
  const schema = Object.fromEntries(
    db.tables.map((t) => [t.name, [t.schema.primKey, ...t.schema.indexes].map((i) => i.src).join(',')]),
  );
  const old = new Dexie(db.name);
  old.version(24).stores(schema);
  await old.table('settings').put({ ...DEFAULT_SETTINGS, ...row });
  old.close();
  await db.open();
  return db.settings.get('app');
}

const NAV = { bottom: ['today'], more: ['goals'], hidden: ['cycle', 'habits'] };

describe('v25: «Женские дни» в женском профиле', () => {
  it('женский профиль: раздел снят со спрятанных, остальное как было', async () => {
    const s = await upgradeFrom24({ gender: 'female', navConfig: NAV });
    expect(s?.navConfig).toEqual({ bottom: ['today'], more: ['goals'], hidden: ['habits'] });
  });

  it('мужской профиль и профиль без пола не трогаются', async () => {
    expect((await upgradeFrom24({ gender: 'male', navConfig: NAV }))?.navConfig?.hidden).toEqual(['cycle', 'habits']);
    expect((await upgradeFrom24({ navConfig: NAV }))?.navConfig?.hidden).toEqual(['cycle', 'habits']);
  });

  it('раскладки нет — upgrade не падает и ничего не создаёт', async () => {
    const s = await upgradeFrom24({ gender: 'female' });
    expect(s?.navConfig).toBeUndefined();
  });

  it('копия до v25 при восстановлении проходит ту же правку, копия v25 — нет', async () => {
    const restore = async (schemaVersion: number) => {
      const row = { ...DEFAULT_SETTINGS, gender: 'female', navConfig: NAV };
      await importBackup(validateBackup({ app: 'life-hub', schemaVersion, exportedAt: '', data: { settings: [row] } }));
      return (await db.settings.get('app'))?.navConfig?.hidden;
    };
    // До v25 «спрятано» могло быть старым умолчанием — показываем, как апгрейд.
    expect(await restore(24)).toEqual(['habits']);
    // С v25 «спрятано» — уже выбор человека.
    expect(await restore(25)).toEqual(['cycle', 'habits']);
  });
});
