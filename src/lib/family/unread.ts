// Непрочитанные сообщения: счёт по группе и общий признак для бейджа.
//
// Раньше и бейдж в таб-баре, и счётчики на вкладках групп поднимали из базы
// всю таблицу сообщений — вместе с фотографиями, голосовыми и кусками файлов,
// которые лежат в тех же строках. Бейдж живёт в таб-баре, то есть на каждом
// экране приложения, и перечитывался на каждое изменение таблицы.
//
// Непрочитанных всегда единицы — читаем только их: составной индекс
// [familyId+seq] даёт диапазон «после того места, где я остановился».

import Dexie from 'dexie';
import { db } from '../../db/db';
import type { FamilyConfig, FamilyMessage } from '../../db/types';

/** То, что человек должен заметить: сообщение-пузырь или пропущенный звонок.
 *  Реакция, кусок файла и прочие служебные строки («Вася вошёл в группу»,
 *  запись о состоявшемся звонке) — нет: в списке чатов они давали бы
 *  «1 непрочитанное» рядом со старым сообщением. Одно правило на бейдж,
 *  превью списка и метку «Непрочитанные» в ленте. */
export const isNotable = (m: FamilyMessage) =>
  !m.deletedAt && !m.reaction && !m.fileChunk && (!(m.system || m.sys) || m.sys?.kind === 'callMissed');

/** Сообщения группы после отметки прочтения: чужие и заметные. */
function unreadRange(cfg: Pick<FamilyConfig, 'familyId' | 'lastReadSeq' | 'selfMemberId'>) {
  return db.familyMessages
    .where('[familyId+seq]')
    .between([cfg.familyId, cfg.lastReadSeq], [cfg.familyId, Dexie.maxKey], false, true)
    .filter((m: FamilyMessage) => isNotable(m) && m.senderMemberId !== cfg.selfMemberId);
}

/** Сколько непрочитанных в одной группе. */
export function countUnread(
  cfg: Pick<FamilyConfig, 'familyId' | 'lastReadSeq' | 'selfMemberId'>,
): Promise<number> {
  return unreadRange(cfg).count();
}

/** Есть ли непрочитанное хоть в одной группе. Останавливается на первом
 *  найденном — для бейджа число не нужно, нужен факт. */
export async function hasAnyUnread(
  cfgs: Pick<FamilyConfig, 'familyId' | 'lastReadSeq' | 'selfMemberId'>[],
): Promise<boolean> {
  for (const cfg of cfgs) {
    if (await unreadRange(cfg).first()) return true;
  }
  return false;
}
