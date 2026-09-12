import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { db, SCHEMA_VERSION } from './db';

it('SCHEMA_VERSION совпадает с версией схемы Dexie', async () => {
  await db.open();
  expect(SCHEMA_VERSION).toBe(db.verno);
});
