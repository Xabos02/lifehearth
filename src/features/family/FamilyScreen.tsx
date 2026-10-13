import { useSyncExternalStore, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import type { LucideIcon } from 'lucide-react';
import { db } from '../../db/db';
import type { FamilyConfig } from '../../db/types';
import { Screen } from '../../components/layout/Screen';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { ICON } from '../../components/ui/icons';
import { screenAction, subscribeScreenAction } from '../../lib/ui/screenAction';
import { t } from '../../lib/i18n';
import { MembersTab } from './MembersTab';
import { ChatTab } from './ChatTab';
import { FamilyTasksTab } from './FamilyTasksTab';
import { CallButton } from './CallButton';
import { GroupAvatar, MemberAvatar } from './MemberAvatar';
import { useFamilyStatusLine } from './useFamilyStatusLine';
import { chatPath, isAlive, isGroupChat, partnerOf } from './chats';

export type GroupView = 'chat' | 'tasks' | 'members';

/** Экран одной группы: чат, её задачи или карточка (участники и управление).
 *  Вкладок больше нет — в чат входят из списка, в карточку — нажатием на
 *  название в шапке, как в мессенджерах; в задачи — из списка и из карточки. */
export function FamilyScreen({ config, first, view }: { config: FamilyConfig; first: boolean; view: GroupView }) {
  const navigate = useNavigate();
  const { state } = useLocation();
  const familyId = config.familyId;
  const members = useLiveQuery(() => db.familyMembers.where('familyId').equals(familyId).toArray(), [familyId]);
  // До ответа базы личный чат на кадр выглядел бы групповым: название пары,
  // знак семьи, «Пригласить». Пустая шапка честнее вспышки.
  if (!members) {
    return (
      <Screen title="" backTo="/more/family">
        <div />
      </Screen>
    );
  }
  const partner = isGroupChat(first, members.filter(isAlive).length) ? undefined : partnerOf(config, members);
  const title = partner?.displayName ?? (config.familyName || t('Семья'));
  const onLeft = () => navigate('/more/family', { replace: true });

  if (view === 'tasks') {
    // Из карточки — назад в карточку; из списка и по ссылке — в список.
    const fromCard = (state as { from?: string } | null)?.from === 'members';
    return (
      <Screen title={t('Общие задачи')} subtitle={title} backTo={fromCard ? chatPath(familyId, 'members') : '/more/family'}>
        <FamilyTasksTab familyId={familyId} />
      </Screen>
    );
  }

  if (view === 'members') {
    return (
      <Screen title="" backLabel={title} backTo={chatPath(familyId)}>
        <MembersTab familyId={familyId} title={title} partner={partner} onLeft={onLeft} />
      </Screen>
    );
  }

  return (
    <ChatScreen
      config={config}
      title={title}
      person={Boolean(partner)}
      lead={partner ? <MemberAvatar member={partner} className="size-9 text-sm" /> : <GroupAvatar className="size-9" glyph={ICON.base} />}
    />
  );
}

function ChatScreen({ config, title, person, lead }: { config: FamilyConfig; title: string; person: boolean; lead: ReactNode }) {
  const navigate = useNavigate();
  const familyId = config.familyId;
  const status = useFamilyStatusLine(familyId, person);
  // Действие от чата (поиск по переписке): чат сам объявляет о нём, шапка
  // только показывает. Своя строка под кнопку стоила бы переписке высоты.
  const action = useSyncExternalStore(subscribeScreenAction, screenAction, () => null);
  const ActionIcon = action?.icon as LucideIcon | undefined;
  // Группы больше нет — «не в сети» под названием было бы враньём: чинить
  // нечего, правду говорит баннер над чатом.
  const gone = config.removedAt || config.groupDeletedAt;
  return (
    <Screen
      compact
      fill
      title={title}
      subtitle={gone ? undefined : status}
      backTo="/more/family"
      titleLead={lead}
      onTitlePress={() => navigate(chatPath(familyId, 'members'))}
      titlePressHint={t('участники и настройки')}
      right={
        // gap-3: зоны касания обеих кнопок расширены до 44 и при gap-1
        // смыкались — палец над лупой попадал в звонок, а звонок поднимает
        // трезвон у человека на том конце.
        <div className="flex items-center gap-3">
          {action && ActionIcon && (
            <button
              onClick={action.onPress}
              aria-label={action.label}
              className={`flex size-9 items-center justify-center rounded-full text-lh-text-secondary active:text-lh-accent ${HIT_SLOP_44}`}
            >
              <ActionIcon size={ICON.header} />
            </button>
          )}
          <CallButton familyId={familyId} />
        </div>
      }
    >
      <div className="flex h-full flex-col">
        {/* Правда о том, что группы больше нет, — над перепиской. Переписку
            оставляем: она его, стирать её вдогонку к исключению незачем. */}
        {gone && (
          <div className="mb-3 shrink-0 rounded-xl bg-danger/10 p-3 text-sm leading-snug text-danger">
            {config.groupDeletedAt
              ? t('Эту группу удалил её создатель. Переписка на этом устройстве осталась, но новые сообщения приходить не будут.')
              : t('Вас исключили из этой группы. Переписка на этом устройстве осталась, но новые сообщения приходить не будут.')}
          </div>
        )}
        {/* Без внешнего скролла: у ChatTab свой, два вложенных overflow-y-auto
            давали «войну скроллов» и заморозку. */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChatTab familyId={familyId} />
        </div>
      </div>
    </Screen>
  );
}
