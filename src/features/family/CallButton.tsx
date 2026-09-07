import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import type { FamilyMember } from '../../db/types';
import { Sheet } from '../../components/ui/Sheet';
import { GPhone } from '../../components/ui/glyphs';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { getFamilyConfig } from '../../lib/family/familyState';
import { subscribePresence } from '../../lib/family/familyChat';
import { callManager } from '../../lib/family/familyCall';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

/**
 * Звонок из семейного экрана.
 *
 * ГДЕ. В шапке, рядом с названием группы. Звонок относится к людям, а не к
 * содержимому вкладки, — значит он должен быть доступен и из чата, и из задач,
 * и из участников, то есть жить выше вкладок. Раньше трубка была только внутри
 * вкладки «Участники»: чтобы позвонить из переписки, надо было уйти со списка
 * сообщений, найти человека и вернуться.
 *
 * КОМУ. В группе из двоих выбирать не из чего — звоним сразу, одним тапом. В
 * группе побольше открывается список: сначала те, кто в сети, потом остальные.
 * Спрашивать «кому?» там, где собеседник ровно один, — лишний экран на ровном
 * месте; не спрашивать там, где их пятеро, — угадывание.
 */
export function CallButton({ familyId }: { familyId: string }) {
  const config = useLiveQuery(() => getFamilyConfig(familyId), [familyId]);
  const rows = useLiveQuery(
    () => db.familyMembers.where('familyId').equals(familyId).toArray(),
    [familyId],
  );
  const [online, setOnline] = useState<string[]>([]);
  useEffect(() => subscribePresence(familyId, setOnline), [familyId]);
  const [pick, setPick] = useState(false);

  const selfId = config?.selfMemberId;
  // Ушедшим и исключённым не звоним: у первых нет группы, у вторых нет ключа.
  const others = (rows ?? []).filter((m) => m.id !== selfId && !m.leftAt && !m.removedAt);

  // Звонить некому — кнопки нет вовсе. Показывать её, чтобы потом сказать
  // «в группе никого», хуже, чем не показывать.
  if (others.length === 0 || config?.removedAt) return null;

  const onlineSet = new Set(online);
  const sorted = [...others].sort(
    (a, b) =>
      Number(onlineSet.has(b.id)) - Number(onlineSet.has(a.id)) ||
      a.displayName.localeCompare(b.displayName),
  );

  const call = (memberId: string) => {
    setPick(false);
    void callManager.startCall(familyId, memberId);
  };

  return (
    <>
      {/* Не голая иконка, а заметная круглая кнопка в фирменном градиенте
          (как отправка в чате): звонок — главное действие шапки, и человек
          должен видеть, куда нажать, не разглядывая пиктограммы. */}
      <button
        type="button"
        aria-label={others.length === 1 ? t('Позвонить: {name}', { name: others[0].displayName }) : t('Позвонить')}
        onClick={() => (others.length === 1 ? call(others[0].id) : setPick(true))}
        className={`flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-fill text-white active:scale-95 ${HIT_SLOP_44}`}
      >
        <GPhone size={ICON.header} />
      </button>

      <Sheet open={pick} onClose={() => setPick(false)} title={t('Кому позвонить')}>
        <div className="space-y-1 pb-2">
          {sorted.map((m) => (
            <MemberRow key={m.id} member={m} online={onlineSet.has(m.id)} onCall={() => call(m.id)} />
          ))}
        </div>
      </Sheet>
    </>
  );
}

function MemberRow({
  member,
  online,
  onCall,
}: {
  member: FamilyMember;
  online: boolean;
  onCall: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onCall}
      className="flex w-full min-h-14 items-center gap-3 rounded-xl px-2 text-left active:bg-surface-2"
    >
      <span
        aria-hidden
        className="flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
        style={{ background: member.color }}
      >
        {member.displayName.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{member.displayName}</span>
        {/* «Не в сети» — не запрет, а предупреждение: звонок уйдёт пушем, и
            человек может ответить. Прятать таких из списка значило бы решать
            за него, что до него не дозвониться. */}
        <span className={`block text-sm ${online ? 'text-success' : 'text-muted'}`}>
          {online ? t('В сети') : t('Не в сети')}
        </span>
      </span>
      <GPhone size={ICON.header} className="shrink-0 text-accent" />
    </button>
  );
}
