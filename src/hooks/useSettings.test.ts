// Выбор женского пола включает «Женские дни» сам — без похода в настройки.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, DEFAULT_SETTINGS } from '../db/db';
import { updateSettings } from './useSettings';

const NAV = { bottom: ['today', 'tasks'], more: ['goals'], hidden: ['cycle', 'habits'] };

const hidden = async () => (await db.settings.get('app'))?.navConfig?.hidden;

describe('updateSettings: женский пол показывает «Женские дни»', () => {
  beforeEach(async () => {
    await db.open();
    await Promise.all(db.tables.map((t) => t.clear()));
  });

  it('переход на женский снимает раздел со спрятанных, остальное не трогает', async () => {
    await db.settings.put({ ...DEFAULT_SETTINGS, gender: 'male', navConfig: NAV });
    await updateSettings({ gender: 'female' });
    expect(await hidden()).toEqual(['habits']);
    expect((await db.settings.get('app'))?.navConfig?.more).toEqual(['goals']);
  });

  it('первый выбор пола (пол ещё пуст) — тоже переход', async () => {
    await db.settings.put({ ...DEFAULT_SETTINGS, navConfig: NAV });
    await updateSettings({ gender: 'female' });
    expect(await hidden()).toEqual(['habits']);
  });

  it('повторный выбор уже стоящего женского не отменяет «спрятала сама»', async () => {
    await db.settings.put({ ...DEFAULT_SETTINGS, gender: 'female', navConfig: NAV });
    await updateSettings({ gender: 'female' });
    expect(await hidden()).toEqual(['cycle', 'habits']);
  });

  it('мужской пол раскладку не трогает', async () => {
    await db.settings.put({ ...DEFAULT_SETTINGS, gender: 'female', navConfig: NAV });
    await updateSettings({ gender: 'male' });
    expect(await hidden()).toEqual(['cycle', 'habits']);
  });
});
