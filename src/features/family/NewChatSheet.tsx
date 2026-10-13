import { useState, type ReactNode } from 'react';
import { ScanLine } from 'lucide-react';
import type { FamilyConfig, FamilyMember } from '../../db/types';
import { Sheet } from '../../components/ui/Sheet';
import { GChevronRight, GFamily } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { useToast } from '../../components/ui/toastContext';
import { createFamily } from '../../lib/family/familyLifecycle';
import { t } from '../../lib/i18n';
import { CreateFamilySheet, JoinFamilySheet } from './FamilyOnboarding';
import { FamilyInviteSheet } from './FamilyInviteSheet';
import { MemberAvatar } from './MemberAvatar';
import { isAlive, partnerOf, pendingPartners, rememberPending } from './chats';

const norm = (s: string) => s.trim().toLocaleLowerCase();

/**
 * «Новый чат» (канва design/family-chats, артборд New-Chat).
 *
 * Личный чат — новая группа на двоих со своим ключом. Человек входит в неё
 * так же, как в семью: один раз сканирует QR и вводит кодовое слово. Создать
 * пару молча, без этого шага, нельзя без смены модели безопасности
 * (docs/family-chat-security.md: ключ передаётся только с глазу на глаз).
 */
export function NewChatSheet({
  open,
  onClose,
  groups,
  pairs,
  members,
  onOpenChat,
}: {
  open: boolean;
  onClose: () => void;
  groups: FamilyConfig[];
  pairs: FamilyConfig[];
  members: FamilyMember[];
  onOpenChat: (familyId: string) => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<null | 'create' | 'join'>(null);
  const [inviteFor, setInviteFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Люди из общих групп, кроме меня. Один человек в разных группах — разные
  // memberId: общей личности между группами нет (memberId рождается при
  // входе). Склеивать по имени нельзя — две «Мамы» из разных групп слились
  // бы в одну строку, и личный чат открылся бы не с тем человеком.
  const people = groups.flatMap((g) =>
    members
      .filter((m) => m.familyId === g.familyId && m.id !== g.selfMemberId && isAlive(m))
      .map((member) => ({ member, source: g })),
  );
  const sameName = new Map<string, number>();
  for (const { member } of people) sameName.set(norm(member.displayName), (sameName.get(norm(member.displayName)) ?? 0) + 1);

  // Уже есть ли чат с человеком: у пары — по имени собеседника, у ожидающей —
  // по имени того, кого позвали. Только при единственном таком имени: иначе
  // не угадать, с кем из двоих этот чат.
  const pending = pendingPartners();
  const chatWith = (name: string) => {
    if (sameName.get(norm(name)) !== 1) return undefined;
    for (const p of pairs) {
      const partner = partnerOf(p, members);
      const who = partner?.displayName ?? pending[p.familyId];
      if (who && norm(who) === norm(name)) return { id: p.familyId, waiting: !partner };
    }
    return undefined;
  };

  async function start(person: FamilyMember, source: FamilyConfig) {
    // Своё имя — то, под которым меня знают в общей группе: вводить его на
    // каждую пару заново незачем.
    const myName = members.find((m) => m.familyId === source.familyId && m.id === source.selfMemberId)?.displayName ?? '';
    setBusy(person.id);
    try {
      // Название нейтральное: в списке и шапке пару всё равно видно под
      // именем собеседника, а название открыто лежит в коде приглашения.
      const id = await createFamily(t('Личный чат'), myName);
      rememberPending(id, person.displayName);
      setInviteFor(id);
    } catch {
      toast(t('Не удалось создать чат. Попробуйте ещё раз'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Sheet open={open && !mode && !inviteFor} onClose={onClose} title={t('Новый чат')}>
        <div className="pb-2">
          <h3 className="mb-1 px-1 text-sm font-semibold text-lh-text-secondary">{t('Личный чат')}</h3>
          {people.length === 0 && (
            <p className="px-1 pb-2 text-sm text-lh-text-secondary">{t('Пока не с кем: сначала пригласите людей в общую группу')}</p>
          )}
          {people.map(({ member, source }) => {
            const chat = chatWith(member.displayName);
            return (
              <Row
                key={`${source.familyId}:${member.id}`}
                icon={<MemberAvatar member={member} className="size-10 text-base" />}
                title={member.displayName}
                hint={
                  chat?.waiting
                    ? t('Ждём, пока войдёт по приглашению')
                    : chat
                      ? t('Чат уже есть')
                      : groups.length > 1
                        ? t('Из группы «{name}»', { name: source.familyName })
                        : undefined
                }
                disabled={busy !== null}
                // Ожидающей паре — то же приглашение заново, а не вторая пара.
                onClick={() => (chat?.waiting ? setInviteFor(chat.id) : chat ? onOpenChat(chat.id) : void start(member, source))}
                end={
                  chat && !chat.waiting ? (
                    <GChevronRight size={ICON.header} className="shrink-0 text-lh-text-secondary" />
                  ) : (
                    <span className="shrink-0 font-semibold text-lh-accent">
                      {busy === member.id ? t('Создаём…') : chat ? t('Показать QR') : t('Начать чат')}
                    </span>
                  )
                }
              />
            );
          })}

          <h3 className="mt-4 mb-1 px-1 text-sm font-semibold text-lh-text-secondary">{t('Ещё')}</h3>
          <Row
            icon={<RingIcon><GFamily size={ICON.header} /></RingIcon>}
            title={t('Новая группа')}
            hint={t('Название, потом приглашение')}
            onClick={() => setMode('create')}
          />
          <Row
            icon={<RingIcon><ScanLine size={ICON.header} /></RingIcon>}
            title={t('Войти по приглашению')}
            hint={t('QR или код и кодовое слово')}
            onClick={() => setMode('join')}
          />

          {/* Обещаем ровно то, что делает код: ключ свой, остальная семья чат не
              видит. «Только вы двое» было бы неправдой — приглашение сутки
              открывает вход любому, у кого есть QR и слово. */}
          <p className="mt-4 px-1 text-xs text-lh-text-secondary">
            {t('Личный чат — отдельная группа на двоих со своим ключом: остальные в семье его не видят. Пока приглашение действует (сутки), войти может любой, у кого есть ваш QR и кодовое слово, — показывайте их только собеседнику.')}
          </p>
        </div>
      </Sheet>

      <CreateFamilySheet
        open={open && mode === 'create'}
        onClose={() => setMode(null)}
        onReady={(id) => {
          setMode(null);
          onOpenChat(id);
        }}
      />
      <JoinFamilySheet
        open={open && mode === 'join'}
        onClose={() => setMode(null)}
        onReady={(id) => {
          setMode(null);
          onOpenChat(id);
        }}
      />
      {inviteFor && (
        <FamilyInviteSheet
          familyId={inviteFor}
          open
          onClose={() => {
            const id = inviteFor;
            setInviteFor(null);
            onOpenChat(id);
          }}
        />
      )}
    </>
  );
}

function RingIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-lh-border-strong text-lh-text-secondary">
      {children}
    </span>
  );
}

function Row({
  icon,
  title,
  hint,
  end,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  end?: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-15 w-full items-center gap-3 rounded-xl px-1 text-left active:bg-lh-surface-2 disabled:opacity-60"
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-medium">{title}</span>
        {hint && <span className="block truncate text-xs text-lh-text-secondary">{hint}</span>}
      </span>
      {end}
    </button>
  );
}
