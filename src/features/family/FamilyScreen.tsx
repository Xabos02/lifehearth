import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import type { LucideIcon } from 'lucide-react';
import { db } from '../../db/db';
import type { FamilyConfig, FamilyMember } from '../../db/types';
import { Screen } from '../../components/layout/Screen';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { ICON } from '../../components/ui/icons';
import { Button } from '../../components/ui/Button';
import { JoinFamilySheet } from './FamilyOnboarding';
import { useToast } from '../../components/ui/toastContext';
import { screenAction, subscribeScreenAction } from '../../lib/ui/screenAction';
import { t, tPlur } from '../../lib/i18n';
import { MembersTab } from './MembersTab';
import { FamilyInviteSheet } from './FamilyInviteSheet';
import { ChatTab } from './ChatTab';
import { FamilyTasksTab } from './FamilyTasksTab';
import { CallButton } from './CallButton';
import { MemberAvatar, StackAvatar } from './MemberAvatar';
import { chatPresence, subscribeChatPresence } from './chatPresence';
import { useFamilyStatusLine } from './useFamilyStatusLine';
import { awaitingPartner, chatPath, isAlive, isGroupChat, partnerOf, pendingPartners } from './chats';

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
  const pair = !isGroupChat(first, members.filter(isAlive).length);
  const partner = pair ? partnerOf(config, members) : undefined;
  // Личный чат, куда собеседник ещё не вошёл, — под именем того, кого позвали
  // (как строка в списке), а не под безликим «Личный чат».
  const waiting = pair && awaitingPartner(config, members) && !config.removedAt && !config.groupDeletedAt;
  const title = partner?.displayName ?? (waiting ? pendingPartners()[familyId] : undefined) ?? (config.familyName || t('Семья'));
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
        <MembersTab familyId={familyId} title={title} partner={partner} waiting={waiting} onLeft={onLeft} />
      </Screen>
    );
  }

  const alive = members.filter(isAlive);
  return (
    <ChatScreen
      config={config}
      title={title}
      partner={partner}
      alive={alive}
      pair={pair}
      waiting={waiting}
      waitingName={waiting ? pendingPartners()[familyId] : undefined}
    />
  );
}

function ChatScreen({
  config,
  title,
  partner,
  alive,
  pair,
  waiting,
  waitingName,
}: {
  config: FamilyConfig;
  title: string;
  partner: FamilyMember | undefined;
  alive: FamilyMember[];
  /** Личный вид чата (на двоих): от него заголовок приглашения. */
  pair: boolean;
  /** Личный чат, куда собеседник ещё не вошёл. */
  waiting: boolean;
  waitingName?: string;
}) {
  const navigate = useNavigate();
  const { pathname, search, state } = useLocation();
  const familyId = config.familyId;
  // Новый личный чат открывается сразу с приглашением поверх (state.invite от
  // «Нового чата» и первого экрана семьи): закрыли QR — вы в переписке.
  const [inviteOpen, setInviteOpen] = useState(() => (state as { invite?: boolean } | null)?.invite === true);
  const closeInvite = () => {
    setInviteOpen(false);
    // Пометку из истории убираем: иначе «назад-вперёд» и перезагрузка
    // (history.state её переживает) снова открывали бы QR.
    if ((state as { invite?: boolean } | null)?.invite) navigate(pathname + search, { replace: true, state: null });
  };
  // Собеседник вошёл, пока QR открыт (приглашают обычно при встрече, держа
  // экран перед ним), — шторка закрывается сама, и видно, что он в чате.
  // Иначе живой QR висел бы дальше, а заголовок без перемен.
  const toast = useToast();
  const wasWaiting = useRef(waiting);
  useEffect(() => {
    if (wasWaiting.current && !waiting && partner && inviteOpen) {
      closeInvite();
      toast(t('{name} в чате', { name: partner.displayName }));
    }
    wasWaiting.current = waiting;
  });
  // Только сбой НАШЕЙ связи («нет связи», «подключение…»): пока связь есть,
  // под именем — присутствие собеседников, как в мессенджерах.
  const conn = useFamilyStatusLine(familyId, true);
  const presence = useSyncExternalStore(subscribeChatPresence, chatPresence, () => null);
  const p = presence?.familyId === familyId ? presence : null;
  const others = alive.filter((m) => m.id !== config.selfMemberId);
  const partnerOnline = Boolean(partner && p?.onlineIds.includes(partner.id));
  const lead: ReactNode = partner ? (
    <span className="relative shrink-0">
      <MemberAvatar member={partner} className="size-10 text-sm" />
      {partnerOnline && (
        <span className="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-lh-bg bg-success" />
      )}
    </span>
  ) : (
    <StackAvatar members={others} />
  );
  const tone = (s: string | null | undefined, k: 'typing' | 'online' | 'plain') =>
    s ? <span className={k === 'typing' ? 'text-lh-accent' : k === 'online' ? 'text-success' : ''}>{s}</span> : null;
  // Личный чат, где ждём собеседника, — не «1 участник»: это не группа.
  const count = partner || waiting ? null : tPlur(alive.length, ['участник', 'участника', 'участников']);
  // Общий чат на двоих (первая группа всегда общая: «вы и жена») — под
  // названием статус собеседника с именем, как над лентой до редизайна:
  // «Жена · был(а) в сети 2 ч назад». Без числа участников: строка
  // обрезается, и на 375px от статуса остались бы «был(а)…».
  const solo = !partner && others.length === 1 ? others[0] : undefined;
  const presenceNode =
    solo && p?.text
      ? <>{solo.displayName} · {tone(p.text, p.tone)}</>
      : p?.tone === 'typing'
        ? tone(p.text, 'typing')
        : partner
          ? tone(p?.text, p?.tone ?? 'plain')
          : p?.tone === 'online'
            ? // Себя тоже: «4 участника» считает и вас, и ветка рисуется только
              // при нашей связи (conn === 'online'), — иначе все в сети, а
              // подпись «4 участника · 3 в сети».
              <>{count} · {tone(t('{n} в сети', { n: alive.filter((m) => m.id === config.selfMemberId || p.onlineIds.includes(m.id)).length }), 'online')}</>
            : count;
  const subtitleNode: ReactNode = conn ? <>{count ? `${count} · ` : ''}{conn}</> : waiting ? undefined : presenceNode;
  // Действие от чата (поиск по переписке): чат сам объявляет о нём, шапка
  // только показывает. Своя строка под кнопку стоила бы переписке высоты.
  const action = useSyncExternalStore(subscribeScreenAction, screenAction, () => null);
  const ActionIcon = action?.icon as LucideIcon | undefined;
  // Группы больше нет — «не в сети» под названием было бы враньём: чинить
  // нечего, правду говорит баннер над чатом.
  const gone = config.removedAt || config.groupDeletedAt;
  // Сервер не признал это устройство (familyChat: unverifiedAt) — тоже не
  // «не в сети»: связь не вернётся сама, выход один — новое приглашение.
  const unverified = Boolean(config.unverifiedAt);
  const [joining, setJoining] = useState(false);
  return (
    <Screen
      compact
      fill
      title={title}
      subtitleNode={gone || unverified ? undefined : subtitleNode}
      backTo="/more/family"
      titleLead={lead}
      onTitlePress={() => navigate(chatPath(familyId, 'members'))}
      titlePressHint={t('участники и настройки')}
      right={
        // gap-3: зоны касания обеих кнопок расширены до 44 и при gap-1
        // смыкались — палец над лупой попадал в звонок, а звонок поднимает
        // трезвон у человека на том конце.
        <div className="flex items-center gap-3">
          {/* Порядок макета: звонок, затем поиск. */}
          <CallButton familyId={familyId} />
          {action && ActionIcon && (
            <button
              onClick={action.onPress}
              aria-label={action.label}
              className={`flex size-9 items-center justify-center rounded-full text-lh-text-secondary active:text-lh-accent ${HIT_SLOP_44}`}
            >
              <ActionIcon size={ICON.action} />
            </button>
          )}
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
        {/* Жёлтый, а не красный, как у «исключили»: здесь всё чинится, и кнопка
            ведёт прямо к входу (канва design/family-unverified, вариант Б). */}
        {unverified && (
          <div className="mb-3 shrink-0 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm leading-snug">
            <p>{t('Это устройство не может подтвердить, что вы участник группы. Попросите новое приглашение.')}</p>
            <Button variant="secondary" className="mt-3 w-full" onClick={() => setJoining(true)}>
              {t('Ввести приглашение')}
            </Button>
          </div>
        )}
        <JoinFamilySheet
          open={joining}
          onClose={() => setJoining(false)}
          onReady={(id) => navigate(chatPath(id), { replace: true })}
        />
        {/* Собеседник ещё не вошёл — над перепиской правда об этом и QR ещё
            раз: шторку приглашения легко закрыть раньше, чем он отсканирует,
            а приглашение живёт сутки. Писать можно уже сейчас — вошедший
            увидит переписку. */}
        {waiting && !gone && (
          <div className="card mb-3 flex shrink-0 items-center gap-3 p-3">
            <span className="min-w-0 flex-1 text-sm leading-snug text-lh-text-secondary">
              {waitingName
                ? t('Ждём, пока {name} войдёт по приглашению', { name: waitingName })
                : t('Ждём, пока собеседник войдёт по приглашению')}
            </span>
            <button
              type="button"
              onClick={() => setInviteOpen(true)}
              className={`shrink-0 font-semibold text-lh-accent active:opacity-60 ${HIT_SLOP_44}`}
            >
              {t('Показать QR')}
            </button>
          </div>
        )}
        {/* Без внешнего скролла: у ChatTab свой, два вложенных overflow-y-auto
            давали «войну скроллов» и заморозку. */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChatTab familyId={familyId} />
        </div>
      </div>
      <FamilyInviteSheet familyId={familyId} pair={pair} open={inviteOpen} onClose={closeInvite} />
    </Screen>
  );
}
