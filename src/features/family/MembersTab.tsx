import { useEffect, useMemo, useState } from 'react';
import Dexie from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  UserPlus,
  LogOut,
  UserMinus,
  PhoneOff,
  Trash2,
  ClipboardCheck,
} from 'lucide-react';
import {
  GPencil as Pencil,
  GPhone as Phone,
  GPlus as Plus,
  GChevronRight as ChevronRight,
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
import { getLang, t, tPlur } from '../../lib/i18n';
import { previewByMember, previewWhen } from './memberPreview';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';

/** Сколько сообщений хвоста ленты смотрим ради строк участников. */
const PREVIEW_WINDOW = 300;

export function MembersTab({
  familyId,
  onLeft,
  onAddGroup,
  onOpenTasks,
}: {
  familyId: string;
  onLeft: () => void;
  onAddGroup?: () => void;
  onOpenTasks?: () => void;
}) {
  const members = useLiveQuery(() => db.familyMembers.where('familyId').equals(familyId).toArray(), [familyId]) ?? [];
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

  // ponytail: смотрим только хвост ленты — у молчавшего дольше PREVIEW_WINDOW
  // сообщений участника строка покажет статус вместо реплики. Индекс по
  // [familyId+sender+seq] — если это начнёт мешать.
  const recent = useLiveQuery(
    () =>
      db.familyMessages
        .where('[familyId+seq]')
        .between([familyId, Dexie.minKey], [familyId, Dexie.maxKey])
        .reverse()
        .limit(PREVIEW_WINDOW)
        .toArray(),
    [familyId],
  );
  const previews = useMemo(
    () => previewByMember(recent ?? [], selfId, config?.lastReadSeq ?? 0),
    [recent, selfId, config?.lastReadSeq],
  );
  const activeTasks =
    useLiveQuery(
      () => db.familyTasks.where('familyId').equals(familyId).filter((x) => !x.deletedAt && !x.completedAt).count(),
      [familyId],
    ) ?? 0;
  const locale = getLang() === 'ru' ? 'ru-RU' : 'en-US';
  const [now] = useState(() => new Date());

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
    if (!window.confirm(
      t('Стать владельцем группы?\n\nВладелец — единственный, кто может исключать участников. Обратно передать владение нельзя, и второго владельца не будет. Берите, только если эту группу создали вы.'),
    )) return;
    setClaiming(true);
    const ok = await claimOwnership(familyId);
    setClaiming(false);
    if (ok) setOwnerless(false);
    else window.alert(t('Не получилось: владельца уже забрал кто-то другой либо нет связи.'));
  }

  async function leave() {
    if (!window.confirm(t('Выйти из группы? Её общий чат и задачи перестанут синхронизироваться на этом устройстве.'))) return;
    await leaveFamily(familyId);
    onLeft();
  }

  async function removeGroup() {
    if (!window.confirm(t('Удалить группу навсегда?\n\nОна исчезнет у всех участников: переписка, задачи и звонки станут недоступны, а вернуть их будет нельзя. Продолжить?'))) return;
    try {
      await deleteFamily(familyId);
      onLeft();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : t('Не удалось удалить группу. Проверьте связь и попробуйте ещё раз'));
    }
  }

  return (
    <div className="space-y-3">
      {/* Макет семьи: строки прямо на фоне, без карточки; волосяной
          разделитель начинается от текста, а не от края — под аватаром пусто. */}
      <div>
        {alive.map((m, i) => {
          const p = previews.get(m.id);
          const status =
            m.id === selfId ? t('вы') : m.removedAt ? t('исключён') : onlineSet.has(m.id) ? t('в сети') : t('не в сети');
          const line = p
            ? p.last.text || (p.last.image ? t('Фото') : p.last.audio ? t('Голосовое сообщение') : p.last.file ? t('Файл') : status)
            : status;
          return (
            <div key={m.id} className="relative flex w-full items-center gap-3 py-2.5">
              <button
                onClick={() => {
                  if (m.id === selfId) setEditName(true);
                }}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left active:opacity-80"
              >
                <span className="relative shrink-0">
                  <span className="flex size-11 items-center justify-center rounded-full bg-lh-accent-dim text-sm font-semibold text-lh-accent">
                    {m.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  {/* У себя — тоже по списку сервера, без поблажки «я всегда в
                      сети»: он включает и это устройство, пока оно на связи. */}
                  {onlineSet.has(m.id) && (
                    <span data-testid="presence-dot" className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-success ring-2 ring-lh-bg" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={`min-w-0 flex-1 truncate text-sm font-medium ${m.removedAt ? 'line-through opacity-60' : ''}`}>
                      {m.displayName}
                      {m.id === selfId && <span className="font-normal text-lh-text-secondary"> · {t('вы')}</span>}
                    </span>
                    {p && (
                      <span className={`shrink-0 text-2xs tabular-nums ${p.unread ? 'text-lh-accent' : 'text-lh-text-secondary'}`}>
                        {previewWhen(p.last.createdAt, now, locale, t('Вчера'))}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-lh-text-secondary">{line}</span>
                    {p && p.unread > 0 && (
                      <span className="flex h-[1.1rem] min-w-[1.1rem] shrink-0 items-center justify-center rounded-full bg-lh-accent px-1 text-2xs font-semibold leading-none text-lh-bg">
                        {p.unread > 99 ? '99+' : p.unread}
                      </span>
                    )}
                  </span>
                </span>
              </button>
              {m.id !== selfId && !m.removedAt && (
                <>
                  {isOwner && (
                    <button
                      onClick={() => setRemoving(m)}
                      aria-label={t('Исключить {name}', { name: m.displayName })}
                      className={`flex size-10 shrink-0 items-center justify-center rounded-full text-danger active:scale-95 ${HIT_SLOP_44}`}
                    >
                      <UserMinus size={ICON.base} />
                    </button>
                  )}
                  <button
                    onClick={() => void callManager.startCall(familyId, m.id)}
                    aria-label={t('Позвонить {name}', { name: m.displayName })}
                    className={`flex size-10 shrink-0 items-center justify-center rounded-full text-lh-text-secondary active:scale-95 active:text-lh-accent ${HIT_SLOP_44}`}
                  >
                    <Phone size={ICON.base} />
                  </button>
                </>
              )}
              {i < alive.length - 1 && <span aria-hidden className="absolute right-0 bottom-0 left-14 h-px bg-lh-border" />}
            </div>
          );
        })}
      </div>

      {onOpenTasks && (
        <button
          onClick={onOpenTasks}
          className="flex min-h-11 w-full items-center gap-3 card px-4 py-3.5 text-left active:opacity-80"
        >
          <ClipboardCheck size={ICON.header} className="shrink-0 text-lh-accent" />
          <span className="min-w-0 flex-1 truncate text-sm">{t('Общие задачи')}</span>
          <span className="shrink-0 text-xs text-lh-text-secondary">{tPlur(activeTasks, ['активная', 'активные', 'активных'])}</span>
          <ChevronRight size={ICON.action} className="shrink-0 text-lh-text-secondary" />
        </button>
      )}

      <button
        onClick={() => setRenaming(true)}
        className="flex w-full items-center gap-2 card px-4 py-3 text-left active:opacity-80"
      >
        <Pencil size={ICON.action} className="shrink-0 text-lh-text-secondary" />
        <span className="flex-1 truncate font-medium">{config?.familyName || t('Семья')}</span>
        <span className="text-sm text-lh-text-secondary">{t('Переименовать')}</span>
      </button>

      <Button onClick={() => setInvite(true)} className="w-full inline-flex items-center justify-center gap-2">
        <UserPlus size={ICON.base} />
        {t('Пригласить участника')}
      </Button>

      {/* Разбор последнего сорвавшегося звонка. Живёт здесь, а не в общих
          настройках: сюда человек и приходит, когда «не дозвонился». */}
      <button
        onClick={() => setDiag(true)}
        className="flex w-full items-center gap-2 card px-4 py-3 text-left active:opacity-80"
      >
        <PhoneOff size={ICON.action} className="shrink-0 text-lh-text-secondary" />
        <span className="flex-1 truncate font-medium">{t('Почему звонок не вышел')}</span>
        <ChevronRight size={ICON.action} className="shrink-0 text-lh-text-secondary" />
      </button>

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

      {/* Вход в создание/подключение второй группы. Раньше жил в свитчере
          групп над чатом, но при единственной группе свитчер скрыт (он лишь
          дублировал заголовок) — а возможность завести вторую группу обязана
          оставаться находимой. */}
      {onAddGroup && (
        <button
          onClick={onAddGroup}
          className="flex w-full items-center justify-center gap-2 card px-4 py-3 text-sm font-medium active:opacity-80"
        >
          <Plus size={ICON.action} className="shrink-0 text-lh-text-secondary" />
          {t('Добавить группу')}
        </button>
      )}

      {isOwner && (
        <button
          onClick={() => void removeGroup()}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3.5 text-sm font-semibold text-danger active:opacity-70"
        >
          <Trash2 size={ICON.action} />
          {t('Удалить группу')}
        </button>
      )}

      {/* min-h-11 вместо pt-2: кнопка во всю ширину, а квадрат HIT_SLOP_44
          стоит по центру — у краёв высота осталась бы 34px. Отступ сверху
          теперь даёт поле самой кнопки. */}
      <button onClick={() => void leave()} className="flex min-h-11 w-full items-center justify-center gap-2 text-sm text-danger active:opacity-60">
        <LogOut size={ICON.action} />
        {t('Выйти из группы')}
      </button>

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
