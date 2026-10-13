import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import Dexie from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import type { FamilyConfig, FamilyMember, FamilyMessage } from '../../db/types';
import { Screen } from '../../components/layout/Screen';
import { IconButton } from '../../components/ui/IconButton';
import {
  GBellRing,
  GChevronRight,
  GClose,
  GPhoto,
  GPlus,
  GSettings,
  GTasks,
} from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { useToast } from '../../components/ui/toastContext';
import { countUnread, isNotable } from '../../lib/family/unread';
import { systemMessageText } from '../../lib/family/systemMessage';
import { registerAllFamilyPush } from '../../lib/family/familyChat';
import { enablePush, isStandalone, pushEnabled, pushSupported } from '../../lib/push';
import { getLang, t, tPlur } from '../../lib/i18n';
import { ManageGroupsSheet } from './ManageGroupsSheet';
import { NewChatSheet } from './NewChatSheet';
import { GroupAvatar, MemberAvatar } from './MemberAvatar';
import { chatPath, isAlive, partnerOf, pendingPartners, previewWhen, snippetOf, splitChats } from './chats';

interface Summary {
  last?: FamilyMessage;
  unread: number;
  tasks: number;
}

/**
 * «Семья» — список чатов, как в мессенджере (канва design/family-chats, Б):
 * общие чаты сверху карточками вместе со своими задачами, ниже «Личные» —
 * группы на двоих, каждая под именем и цветом собеседника.
 */
export function ChatList({ configs }: { configs: FamilyConfig[] }) {
  const navigate = useNavigate();
  const [manageOpen, setManageOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [now] = useState(() => new Date());

  const data = useLiveQuery(async () => {
    const members = await db.familyMembers.toArray();
    const sums: Record<string, Summary> = {};
    for (const c of configs) {
      // ponytail: не ушедшее на сервер (seq ещё null) в индекс [familyId+seq]
      // не попадает и в превью не видно, пока сервер не даст номер — обычно
      // доли секунды; без сети превью отстаёт до подключения.
      const last = await db.familyMessages
        .where('[familyId+seq]')
        .between([c.familyId, Dexie.minKey], [c.familyId, Dexie.maxKey])
        .reverse()
        .filter(isNotable)
        .first();
      const tasks = await db.familyTasks
        .where('familyId')
        .equals(c.familyId)
        .filter((x) => !x.completedAt && !x.deletedAt)
        .count();
      sums[c.familyId] = { last, unread: await countUnread(c), tasks };
    }
    return { members, sums };
  }, [configs]);

  // До первого ответа базы — пустой экран, а не список без участников: с ним
  // каждая группа на миг считалась бы «личной» с «Ждём…» в превью.
  if (!data) {
    return (
      <Screen title={t('Семья')} backTo="/home">
        <div />
      </Screen>
    );
  }
  const { members, sums } = data;
  const pending = pendingPartners();
  const { groups, pairs } = splitChats(configs, members);
  const lastAt = (c: FamilyConfig) => sums[c.familyId]?.last?.createdAt ?? c.joinedAt;
  const personal = [...pairs].sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
  const locale = getLang() === 'ru' ? 'ru-RU' : 'en-US';
  const nameOf = (familyId: string, id: string) =>
    members.find((m) => m.familyId === familyId && m.id === id)?.displayName;

  function preview(c: FamilyConfig, pair: boolean, partner?: FamilyMember): ReactNode {
    // Группы больше нет — превью не должно выглядеть живым чатом.
    if (c.groupDeletedAt) return t('Группа удалена');
    if (c.removedAt) return t('Вас исключили из группы');
    const last = sums[c.familyId]?.last;
    if (!last) {
      if (pair && !partner) return t('Ждём, пока войдёт по приглашению');
      return t('Пока нет сообщений');
    }
    const own = last.senderMemberId === c.selfMemberId;
    // В общем чате видно, кто написал; в личном автор и так понятен.
    const who = own ? t('Вы') : pair ? undefined : nameOf(c.familyId, last.senderMemberId);
    return (
      <>
        {who && <span className="shrink-0 text-lh-text-primary">{who}:</span>}
        {last.image && <GPhoto size={ICON.action} className="shrink-0" />}
        <span className="truncate">{(last.sys || last.system ? systemMessageText(last) : snippetOf(last)).replace(/\s+/g, ' ')}</span>
      </>
    );
  }

  const when = (c: FamilyConfig) => {
    const last = sums[c.familyId]?.last;
    return last ? previewWhen(last.createdAt, now, locale, t('Вчера')) : undefined;
  };

  return (
    <Screen
      title={t('Семья')}
      backTo="/home"
      right={<IconButton icon={GSettings} label={t('Управление группами')} onClick={() => setManageOpen(true)} />}
    >
      <PushBanner />

      <div className="space-y-3">
        {groups.map((c) => {
          const s = sums[c.familyId];
          const alive = members.filter((m) => m.familyId === c.familyId && isAlive(m)).length;
          return (
            <div key={c.familyId} className="card">
              <ChatRow
                avatar={<GroupAvatar />}
                title={c.familyName || t('Семья')}
                meta={alive > 1 ? tPlur(alive, ['участник', 'участника', 'участников']) : undefined}
                preview={preview(c, false)}
                when={when(c)}
                unread={s?.unread ?? 0}
                onOpen={() => navigate(chatPath(c.familyId))}
              />
              <button
                type="button"
                onClick={() => navigate(chatPath(c.familyId, 'tasks'))}
                className="flex min-h-13 w-full items-center gap-3 border-t border-lh-border px-4 text-left active:bg-lh-surface-2"
              >
                <GTasks size={ICON.base} className="shrink-0 text-lh-accent" />
                <span className="flex-1 text-sm font-medium">{t('Общие задачи')}</span>
                {(s?.tasks ?? 0) > 0 && (
                  <span className="text-sm text-lh-text-secondary">
                    {tPlur(s!.tasks, ['активная', 'активных', 'активных'])}
                  </span>
                )}
                <GChevronRight size={ICON.header} className="shrink-0 text-lh-text-secondary" />
              </button>
            </div>
          );
        })}
      </div>

      <h2 className="mt-6 mb-1 px-1 text-sm font-semibold text-lh-text-secondary">{t('Личные')}</h2>
      <div className="-mx-4">
        {personal.map((c, i) => {
          const partner = partnerOf(c, members);
          return (
            <ChatRow
              key={c.familyId}
              divider={i > 0}
              avatar={partner ? <MemberAvatar member={partner} /> : <GroupAvatar />}
              title={partner?.displayName ?? pending[c.familyId] ?? (c.familyName || t('Семья'))}
              preview={preview(c, true, partner)}
              when={when(c)}
              unread={sums[c.familyId]?.unread ?? 0}
              onOpen={() => navigate(chatPath(c.familyId))}
            />
          );
        })}
        <button
          type="button"
          onClick={() => setNewOpen(true)}
          className="flex min-h-16 w-full items-center gap-3 px-4 text-left active:bg-lh-surface-2"
        >
          {/* Пунктир — знак «пустого места под чат»; подпись рядом говорит то же
              словами, так что рамка декоративная и контраст 3:1 ей не нужен. */}
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full border border-dashed border-lh-border-strong text-lh-accent">
            <GPlus size={ICON.header} />
          </span>
          <span className="text-base font-medium text-lh-accent">{t('Новый личный чат')}</span>
        </button>
      </div>

      <ManageGroupsSheet open={manageOpen} onClose={() => setManageOpen(false)} configs={configs} />
      <NewChatSheet
        open={newOpen}
        onClose={() => setNewOpen(false)}
        groups={groups}
        pairs={pairs}
        members={members}
        onOpenChat={(id) => {
          setNewOpen(false);
          navigate(chatPath(id));
        }}
      />
    </Screen>
  );
}

function ChatRow({
  avatar,
  title,
  meta,
  preview,
  when,
  unread,
  divider = false,
  onOpen,
}: {
  avatar: ReactNode;
  title: string;
  meta?: string;
  preview: ReactNode;
  when?: string;
  unread: number;
  /** Разделитель от начала текста, а не от края — как в мессенджерах. */
  divider?: boolean;
  onOpen: () => void;
}) {
  return (
    <button type="button" onClick={onOpen} className="flex min-h-18 w-full items-stretch gap-3 pl-4 text-left active:bg-lh-surface-2">
      <span className="flex items-center">{avatar}</span>
      <span className={`flex min-w-0 flex-1 flex-col justify-center py-3 pr-4 ${divider ? 'border-t border-lh-border' : ''}`}>
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-base font-semibold">
            {title}
            {meta && <span className="text-xs font-medium text-lh-text-secondary"> · {meta}</span>}
          </span>
          {when && (
            <span className={`shrink-0 text-xs tabular-nums ${unread > 0 ? 'font-medium text-lh-accent' : 'text-lh-text-secondary'}`}>
              {when}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-lh-text-secondary">
            {typeof preview === 'string' ? <span className="truncate">{preview}</span> : preview}
          </span>
          {unread > 0 && (
            <span
              aria-label={tPlur(unread, ['непрочитанное', 'непрочитанных', 'непрочитанных'])}
              className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-lh-accent px-1.5 text-2xs font-bold text-lh-bg tabular-nums"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/** «Включить уведомления»: без них сообщение семьи узнаёшь, только открыв
 *  приложение. Раньше баннер жил в свёрнутой шторе чата и его почти не видели;
 *  в списке чатов он на виду, а чат больше не отнимает у переписки строку. */
function PushBanner() {
  const toast = useToast();
  const [pushOn, setPushOn] = useState(pushEnabled());
  const [hidden, setHidden] = useState(false);
  if (pushOn || hidden) return null;

  async function enable() {
    if (!pushSupported()) {
      toast(t('Уведомления не поддерживаются этим браузером.'));
      return;
    }
    if (!isStandalone()) {
      toast(t('Уведомления работают только в установленном приложении. Добавьте LifeHearth на экран «Домой» и откройте оттуда.'));
      return;
    }
    const res = await enablePush();
    // Окно согласия закрыли без «Принимаю» — это ответ, а не сбой.
    if (res.reason === 'consent') return;
    if (!res.ok) {
      toast(res.reason === 'denied' ? t('Разрешение не выдано. Включите в настройках устройства.') : t('Не удалось включить уведомления. Проверьте разрешения в настройках устройства'));
      return;
    }
    await registerAllFamilyPush();
    setPushOn(true);
  }

  return (
    <div className="mb-3 flex items-center gap-2 rounded-xl bg-lh-accent-dim px-3 py-2 text-sm">
      <GBellRing size={ICON.action} className="shrink-0 text-lh-accent" />
      <span className="min-w-0 flex-1">{t('Уведомления')}</span>
      <button onClick={() => void enable()} className={`shrink-0 font-semibold text-lh-accent active:opacity-60 ${HIT_SLOP_44}`}>
        {t('Включить')}
      </button>
      {/* ml-3: зона крестика расширена до 44 и при зазоре 4px налезала на
          «Включить» — «скрыть» срабатывало вместо «разрешить». */}
      <button
        onClick={() => setHidden(true)}
        aria-label={t('Скрыть')}
        className={`ml-3 shrink-0 p-1.5 text-lh-text-secondary active:opacity-60 ${HIT_SLOP_44}`}
      >
        <GClose size={ICON.action} />
      </button>
    </div>
  );
}
