// Строка участника в списке «Семьи» (макет): его последнее сообщение в общем
// чате и сколько из его сообщений я ещё не прочитал. Чат у группы один, так
// что «переписка с мамой» — это мамины реплики в нём.

import type { FamilyMessage } from '../../db/types';

export interface MemberPreview {
  last: FamilyMessage;
  unread: number;
}

/** msgs — хвост ленты в любом порядке; служебные записи отсеиваются. */
export function previewByMember(
  msgs: FamilyMessage[],
  selfId: string | undefined,
  lastReadSeq: number,
): Map<string, MemberPreview> {
  const out = new Map<string, MemberPreview>();
  for (const m of msgs) {
    if (m.deletedAt || m.reaction || m.fileChunk || m.system || m.sys) continue;
    const cur = out.get(m.senderMemberId);
    const unread = m.senderMemberId !== selfId && m.seq != null && m.seq > lastReadSeq ? 1 : 0;
    if (!cur) out.set(m.senderMemberId, { last: m, unread });
    else {
      if (m.createdAt > cur.last.createdAt) cur.last = m;
      cur.unread += unread;
    }
  }
  return out;
}

/** Время справа в строке: сегодня — часы, вчера — «вчера», раньше — дата. */
export function previewWhen(iso: string, now: Date, locale: string, yesterday: string): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff <= 0) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (diff === 1) return yesterday;
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}
