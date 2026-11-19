import { useEffect, useState, type ComponentType } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  UserPlus,
  UserMinus,
  MessageCircle as GChat,
} from 'lucide-react';
import {
  GPhone as Phone,
  GPencil,
  GAlert,
  GLock,
  GCheck,
  GPhoneOut,
  GTrash,
  GChevronRight,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import type { FamilyMember } from '../../db/types';
import { Button } from '../../components/ui/Button';
import { Sheet } from '../../components/ui/Sheet';
import { Field, Input } from '../../components/ui/Input';
import { getFamilyConfig } from '../../lib/family/familyState';
import { subscribePresence, renameFamily } from '../../lib/family/familyChat';
import { callManager } from '../../lib/family/familyCall';
import { deleteFamily, leaveFamily } from '../../lib/family/familyLifecycle';
import {
  claimOwnership,
  familyHasOwner,
  planRemoval,
  removeMember,
  type RemovalPlan,
} from '../../lib/family/familyKeys';
import { FamilyInviteSheet } from './FamilyInviteSheet';
import { ProfileNameSheet } from './ProfileNameSheet';
import { CallDiagSheet } from './CallDiagSheet';
import { t, tPlur } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { GroupAvatar, MemberAvatar } from './MemberAvatar';
import { chatPath, isAlive } from './chats';
import { confirmAction } from '../../components/ui/confirmStore';
import { SECTION_BY_ID } from '../../lib/sections';

// Знак раздела «Задачи» — из реестра (PROTOCOL §20): тот же значок, что у раздела в меню.
const TasksIcon = SECTION_BY_ID.get('tasks')!.icon;

type Glyph = ComponentType<{ size?: number | string; className?: string }>;

/** Строка действия карточки группы: значок, название, при нужде пояснение. */
function ActionRow({
  icon: Icon,
  label,
  hint,
  onClick,
  danger = false,
  chevron = false,
}: {
  icon: Glyph;
  label: string;
  hint?: string;
  onClick: () => void;
  danger?: boolean;
  chevron?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left active:bg-lh-surface-2 ${danger ? 'text-danger' : ''}`}
    >
      <Icon size={ICON.action} className={`w-5 shrink-0 ${danger ? '' : 'text-lh-text-secondary'}`} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-lh-text-secondary">{hint}</span>}
      </span>
      {chevron && <GChevronRight size={ICON.action} className="shrink-0 text-lh-text-secondary" />}
    </button>
  );
}

/** Плитка быстрого действия под названием группы. */
function QuickTile({ icon: Icon, label, onClick }: { icon: Glyph; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card flex h-[68px] flex-col items-center justify-center gap-1.5 active:bg-lh-surface-2"
    >
      <Icon size={ICON.base} className="text-lh-accent" />
      <span className="text-xs">{label}</span>
    </button>
  );
}

/** Карточка чата (артборд Group-Info): кто в группе, приглашение, задачи и
 *  управление. Сюда ведёт нажатие на название в шапке чата. */
export function MembersTab({
  familyId,
  title,
  partner,
  onLeft,
}: {
  familyId: string;
  title: string;
  /** Собеседник, если это личный чат: тогда в шапке он, а не группа. */
  partner?: FamilyMember;
  onLeft: () => void;
}) {
  const navigate = useNavigate();
  const members = useLiveQuery(() => db.familyMembers.where('familyId').equals(familyId).toArray(), [familyId]) ?? [];
  const activeTasks =
    useLiveQuery(
      () => db.familyTasks.where('familyId').equals(familyId).filter((x) => !x.completedAt && !x.deletedAt).count(),
      [familyId],
    ) ?? 0;
  const config = useLiveQuery(() => getFamilyConfig(familyId), [familyId]);
  const selfId = config?.selfMemberId;
  const [online, setOnline] = useState<string[]>([]);
  useEffect(() => subscribePresence(familyId, setOnline), [familyId]);
  const onlineSet = new Set(online);
  const [invite, setInvite] = useState(false);
  const [diag, setDiag] = useState(false);
  const [editName, setEditName] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState<FamilyMember | null>(null);

  const alive = members.filter((m) => !m.leftAt).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  const self = alive.find((m) => m.id === selfId);
  // Исключать может только создатель группы: у него есть секрет владельца, и
  // только его сервер пустит. У остальных кнопки нет вовсе — показывать её,
  // чтобы потом отказать, хуже, чем не показывать.
  const isOwner = Boolean(config?.ownerSecret);
  // Группы, созданные до появления владельцев, остались без него: поля
  // ownerSecret тогда не было ни у кого, заявку не шлёт никто, и «Исключить»
  // не появится ни у кого и никогда. Спрашиваем сервер и предлагаем взять
  // владение — явным действием, а не гонкой при подключении.
  const [ownerless, setOwnerless] = useState(false);
  const [claiming, setClaiming] = useState(false);
  useEffect(() => {
    if (isOwner) return;
    let live = true;
    void familyHasOwner(familyId).then((has) => {
      if (live && has === false) setOwnerless(true);
    });
    return () => {
      live = false;
    };
  }, [familyId, isOwner]);

  async function claim() {
    if (!(await confirmAction({ title: t('Стать владельцем группы?\n\nВладелец — единственный, кто может исключать участников. Обратно передать владение нельзя, и второго владельца не будет. Берите, только если эту группу создали вы.'), confirmLabel: t('Стать владельцем'), danger: false }))) return;
    setClaiming(true);
    const ok = await claimOwnership(familyId);
    setClaiming(false);
    if (ok) setOwnerless(false);
    else window.alert(t('Не получилось: владельца уже забрал кто-то другой либо нет связи.'));
  }

  async function leave() {
    // Правда целиком: leaveFamily стирает переписку с телефона, а события
    // «вышел» у протокола нет — остальные не узнают.
    if (!(await confirmAction({ title: t('Выйти из группы? Переписка и задачи удалятся с этого телефона. Остальные об этом не узнают, и их сообщения сюда больше не дойдут.'), confirmLabel: t('Выйти') }))) return;
    await leaveFamily(familyId);
    onLeft();
  }

  async function removeGroup() {
    // Сервер стирает группу, но уже пришедшее остаётся на телефонах: у
    // остальных баннер так и говорит — «переписка на этом устройстве осталась».
    if (!(await confirmAction({ title: t('Удалить группу навсегда?\n\nСервер сотрёт её переписку и задачи, новых сообщений не будет ни у кого. То, что уже пришло на телефоны участников, там останется. Продолжить?'), confirmLabel: t('Удалить группу') }))) return;
    try {
      await deleteFamily(familyId);
      onLeft();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : t('Не удалось удалить группу. Проверьте связь и попробуйте ещё раз'));
    }
  }

  const live = alive.filter(isAlive);
  const onlineCount = live.filter((m) => m.id !== selfId && onlineSet.has(m.id)).length;
  const summary = partner
    ? onlineSet.has(partner.id)
      ? t('в сети')
      : t('не в сети')
    : [tPlur(live.length, ['участник', 'участника', 'участников']), onlineCount > 0 ? t('{n} в сети', { n: onlineCount }) : '']
        .filter(Boolean)
        .join(' · ');

  return (
    <div className="space-y-6 pb-4">
      <section className="flex flex-col items-center pt-1 text-center">
        {partner ? (
          <MemberAvatar member={partner} className="size-20 text-3xl font-light" />
        ) : (
          <GroupAvatar className="size-20" glyph={ICON.display} />
        )}
        <h1 className="mt-4 lh-heading">{title}</h1>
        <p className="mt-1 text-xs text-lh-text-secondary">{summary}</p>
        {/* Быстрые действия плитками (макет «Карточка группы»): чат, звонок
            собеседнику и задачи — три главные причины открыть карточку. */}
        <div className={`mt-5 grid w-full gap-2 ${partner ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <QuickTile icon={GChat} label={t('Чат')} onClick={() => navigate(chatPath(familyId))} />
          {partner && (
            <QuickTile
              icon={Phone}
              label={t('Позвонить')}
              onClick={() => void callManager.startCall(familyId, partner.id)}
            />
          )}
          <QuickTile
            icon={TasksIcon}
            label={activeTasks > 0 ? t('Задачи · {n}', { n: activeTasks }) : t('Задачи')}
            onClick={() => navigate(chatPath(familyId, 'tasks'), { state: { from: 'members' } })}
          />
        </div>
      </section>

      <section>
        <div className="mb-2.5 flex items-center justify-between px-1">
          <h2 className="lh-section">{t('Участники')}</h2>
          {!partner && onlineCount > 0 && (
            <span className="text-xs text-lh-text-secondary">{t('{n} в сети', { n: onlineCount })}</span>
          )}
        </div>
        <div className="divide-y divide-lh-border card">
          {alive.map((m) => {
            const isSelf = m.id === selfId;
            // Действие у строки одно — переименовать себя. Чужая строка — не
            // кнопка: иначе мигает на нажатие и скринридер обещает действие,
            // которого нет. Высота строк одинаковая.
            const Name = isSelf ? 'button' : 'div';
            const online = onlineSet.has(m.id);
            return (
              <div key={m.id} className="flex w-full items-center gap-3 px-4 py-2.5">
                <Name
                  onClick={isSelf ? () => setEditName(true) : undefined}
                  className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 ${isSelf ? 'text-left active:opacity-80' : ''}`}
                >
                  <span className="relative shrink-0">
                    <MemberAvatar member={m} className="size-11 text-sm" />
                    {/* У себя — тоже по списку сервера, без поблажки «я всегда в сети». */}
                    {online && (
                      <span data-testid="presence-dot" className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-success ring-2 ring-lh-surface" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words leading-snug">
                      <span className={m.removedAt ? 'line-through opacity-60' : undefined}>{m.displayName}</span>
                      {isSelf ? (
                        <span className="text-sm text-lh-text-secondary"> · {t('вы')}</span>
                      ) : m.removedAt ? (
                        <span className="text-sm text-lh-text-secondary"> · {t('исключён')}</span>
                      ) : null}
                    </span>
                    {isSelf ? (
                      isOwner && <span className="mt-0.5 block text-xs text-lh-accent">{t('Владелец группы')}</span>
                    ) : (
                      !m.removedAt && (
                        <span className={`mt-0.5 block text-xs ${online ? 'text-success' : 'text-lh-text-secondary'}`}>
                          {online ? t('в сети') : t('не в сети')}
                        </span>
                      )
                    )}
                  </span>
                </Name>
                {!isSelf && !m.removedAt && (
                  <>
                    {isOwner && (
                      <button
                        onClick={() => setRemoving(m)}
                        aria-label={t('Исключить {name}', { name: m.displayName })}
                        className={`flex size-10 shrink-0 items-center justify-center rounded-full text-lh-text-secondary active:scale-95 active:text-danger ${HIT_SLOP_44}`}
                      >
                        <UserMinus size={ICON.base} />
                      </button>
                    )}
                    <button
                      onClick={() => void callManager.startCall(familyId, m.id)}
                      aria-label={t('Позвонить {name}', { name: m.displayName })}
                      className={`flex size-10 shrink-0 items-center justify-center rounded-full text-lh-accent active:scale-95 ${HIT_SLOP_44}`}
                    >
                      <Phone size={ICON.base} />
                    </button>
                  </>
                )}
              </div>
            );
          })}
          {/* Пригласить можно всегда: «личный» здесь только вычисленный вид
              группы на двоих, и прятать кнопку значило бы запереть группу из
              двух. В личном чате — сначала правда о последствиях. */}
          <button
            type="button"
            onClick={async () => {
              if (
                partner &&
                !(await confirmAction({
                  title: t('Пригласить ещё одного человека? Чат станет общим: новый участник увидит всю переписку.'),
                  confirmLabel: t('Пригласить'),
                  danger: false,
                }))
              )
                return;
              setInvite(true);
            }}
            className="flex min-h-14 w-full items-center gap-3 px-4 text-left text-lh-accent active:bg-lh-surface-2"
          >
            <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-full border border-dashed border-lh-accent-border">
              <UserPlus size={ICON.action} />
            </span>
            <span>{t('Пригласить')}</span>
          </button>
        </div>
      </section>

      {ownerless && (
        <div className="card p-4">
          <p className="font-semibold">{t('У группы нет владельца')}</p>
          <p className="mt-0.5 text-sm leading-relaxed text-lh-text-secondary">
            {t('Она создана до того, как появилась возможность исключать участников. Пока владельца нет, исключить никого нельзя.')}
          </p>
          <Button className="mt-3 w-full" disabled={claiming} onClick={() => void claim()}>
            {claiming ? t('Забираем…') : t('Стать владельцем')}
          </Button>
        </div>
      )}

      {/* Новая группа и вход по приглашению живут в «Новом чате» списка. */}
      <section>
        <h2 className="mb-2.5 px-1 lh-section">{partner ? t('Чат') : t('Группа')}</h2>
        <div className="divide-y divide-lh-border card">
          <ActionRow icon={GPencil} label={t('Переименовать группу')} onClick={() => setRenaming(true)} />
          {/* Разбор последнего сорвавшегося звонка: сюда и приходят, когда «не дозвонился». */}
          <ActionRow icon={GAlert} label={t('Почему звонок не вышел')} onClick={() => setDiag(true)} chevron />
          <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
            <GLock size={ICON.action} aria-hidden className="w-5 shrink-0 text-lh-text-secondary" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{t('Шифрование')}</span>
              <span className="block text-xs text-lh-text-secondary">{t('Ключи только на устройствах участников')}</span>
            </span>
            <GCheck size={ICON.action} aria-hidden className="shrink-0 text-success" />
          </div>
        </div>
      </section>

      <section className="divide-y divide-lh-border card">
        <ActionRow icon={GPhoneOut} label={t('Выйти из группы')} onClick={() => void leave()} danger />
        {isOwner && (
          <ActionRow
            icon={GTrash}
            label={t('Удалить группу')}
            hint={t('Сервер сотрёт переписку и задачи, у участников останется уже пришедшее')}
            onClick={() => void removeGroup()}
            danger
          />
        )}
      </section>

      <RemoveMemberSheet
        key={removing?.id ?? 'rm-closed'}
        familyId={familyId}
        member={removing}
        onClose={() => setRemoving(null)}
      />
      <FamilyInviteSheet familyId={familyId} open={invite} onClose={() => setInvite(false)} />
      <CallDiagSheet open={diag} onClose={() => setDiag(false)} />
      <ProfileNameSheet familyId={familyId} open={editName} currentName={self?.displayName ?? ''} onClose={() => setEditName(false)} />
      <RenameSheet
        key={renaming ? `rn-${config?.familyName ?? ''}` : 'rn-closed'}
        familyId={familyId}
        open={renaming}
        current={config?.familyName ?? ''}
        onClose={() => setRenaming(false)}
      />
    </div>
  );
}

/** Подтверждение исключения. Здесь же — единственное место, где человеку
 *  говорят правду о границах: новые сообщения исключённый не прочитает, а
 *  скачанные раньше останутся при нём. Обещать большее нечестно, а промолчать
 *  значит дать понять, что переписка стёрлась и у него. */
function RemoveMemberSheet({
  familyId,
  member,
  onClose,
}: {
  familyId: string;
  member: FamilyMember | null;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<RemovalPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!member) return;
    let alive = true;
    void planRemoval(familyId, member.id).then((p) => {
      if (alive) setPlan(p);
    });
    return () => {
      alive = false;
    };
  }, [familyId, member]);

  async function confirm() {
    if (!member) return;
    setBusy(true);
    setError(null);
    try {
      await removeMember(familyId, member.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Не удалось исключить участника. Проверьте связь и попробуйте ещё раз'));
    } finally {
      setBusy(false);
    }
  }

  const stranded = plan?.stranded ?? [];

  return (
    <Sheet open={Boolean(member)} onClose={onClose} title={t('Исключить {name}?', { name: member?.displayName ?? '' })}>
      <div className="space-y-4 pb-2">
        <ul className="space-y-2 text-sm leading-snug text-lh-text-primary/90">
          <li>{t('Новые сообщения, задачи и звонки станут ему недоступны: группа перейдёт на новый ключ.')}</li>
          {/* Граница, которую исключение не переходит: приглашённые им — свои
              участники со своими ключами. В том числе он сам под другим
              именем, если подготовился заранее (аудит 18.11, S2). */}
          <li>{t('Тех, кого он успел пригласить, это не касается: они останутся в группе, пока вы не исключите и их.')}</li>
          <li>{t('Переписку, которую он уже скачал, вернуть нельзя — она осталась на его устройстве.')}</li>
          <li>{t('Вернуть его можно только новым приглашением.')}</li>
        </ul>

        {stranded.length > 0 && (
          <div className="rounded-2xl border border-warning/40 bg-warning/10 p-3 text-sm leading-snug">
            {/* Не обновившиеся участники не получат новый ключ: передать его
                нечем. Молча выкинуть их вместе с исключённым нельзя. */}
            {t('Вместе с ним группу потеряют: {names}. У них старая версия приложения — новый ключ передать нечем. Попросите их открыть приложение и повторите.', { names: stranded.map((m) => m.displayName).join(', ') })}
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button
          className="w-full bg-danger-fill! text-white!"
          disabled={busy || !plan}
          onClick={() => void confirm()}
        >
          {busy ? t('Исключаем…') : t('Исключить')}
        </Button>
        <button onClick={onClose} className="min-h-11 w-full py-2 text-sm text-lh-text-secondary active:opacity-60">
          {t('Отмена')}
        </button>
      </div>
    </Sheet>
  );
}

function RenameSheet({ familyId, open, current, onClose }: { familyId: string; open: boolean; current: string; onClose: () => void }) {
  const [name, setName] = useState(current);

  async function save() {
    if (!name.trim()) return;
    await renameFamily(familyId, name);
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('Название группы')}>
      <div className="space-y-4">
        <Field label={t('Название группы')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Например, «Наша семья»')} autoFocus />
        </Field>
        <Button className="w-full" disabled={!name.trim()} onClick={() => void save()}>
          {t('Сохранить')}
        </Button>
      </div>
    </Sheet>
  );
}
