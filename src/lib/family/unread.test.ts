// Счёт непрочитанных: что попадает на кружок бейджа, а что нет.
//
// База настоящая (Dexie поверх fake-indexeddb) — правка ради скорости
// переписала чтение на составной индекс, и проверять её имеет смысл только
// против реального индекса, а не против массива в памяти.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { countUnread, hasAnyUnread } from './unread';

const cfg = { familyId: 'f1', lastReadSeq: 3, selfMemberId: 'me' };

type Row = {
  seq: number | null;
  from?: string;
  deleted?: boolean;
  familyId?: string;
};

async function seed(rows: Row[]) {
  await db.familyMessages.clear();
  await db.familyMessages.bulkPut(
    rows.map((r, i) => ({
      clientMsgId: `m${i}`,
      familyId: r.familyId ?? 'f1',
      seq: r.seq,
      senderMemberId: r.from ?? 'p1',
      text: 'привет',
      createdAt: new Date(2026, 0, 1 + i).toISOString(),
      deletedAt: r.deleted ? new Date().toISOString() : null,
    })) as never[],
  );
}

describe('счёт непрочитанных', () => {
  beforeEach(async () => {
    await db.open();
  });

  it('считает только пришедшее после отметки прочтения', async () => {
    await seed([{ seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }]);
    expect(await countUnread(cfg)).toBe(2);
  });

  it('свои сообщения не считаются непрочитанными', async () => {
    await seed([{ seq: 4, from: 'me' }, { seq: 5, from: 'me' }, { seq: 6 }]);
    expect(await countUnread(cfg)).toBe(1);
  });

  it('удалённые не считаются', async () => {
    await seed([{ seq: 4, deleted: true }, { seq: 5 }]);
    expect(await countUnread(cfg)).toBe(1);
  });

  it('чужая группа не подмешивается', async () => {
    await seed([{ seq: 9, familyId: 'f2' }, { seq: 10, familyId: 'f2' }]);
    expect(await countUnread(cfg)).toBe(0);
  });

  it('реакция, «вошёл в группу» и кусок файла — не непрочитанное, пропущенный звонок — да', async () => {
    await seed([{ seq: 4 }, { seq: 5 }, { seq: 6 }, { seq: 7 }, { seq: 8 }]);
    await db.familyMessages.update('m0', { reaction: { targetId: 'x', emoji: '❤️' } });
    await db.familyMessages.update('m1', { system: true, sys: { kind: 'join', name: 'Вася' } });
    await db.familyMessages.update('m2', { fileChunk: { fileId: 'f', idx: 0, total: 2, data: '' } });
    await db.familyMessages.update('m3', { system: true, sys: { kind: 'callMissed' } });
    expect(await countUnread(cfg)).toBe(2);
  });

  it('не ушедшее на сервер не считается: у него ещё нет номера', async () => {
    await seed([{ seq: null }, { seq: null }]);
    expect(await countUnread(cfg)).toBe(0);
  });

  it('признак для бейджа: истина, если непрочитанное есть хоть в одной группе', async () => {
    await seed([{ seq: 2 }, { seq: 12, familyId: 'f2' }]);
    // В f1 всё прочитано, в f2 — нет.
    expect(await hasAnyUnread([cfg])).toBe(false);
    expect(
      await hasAnyUnread([cfg, { familyId: 'f2', lastReadSeq: 5, selfMemberId: 'me' }]),
    ).toBe(true);
  });
});
