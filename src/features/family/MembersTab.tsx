import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  UserPlus,
  LogOut,
  UserMinus,
  PhoneOff,
  Trash2,
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
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';

export function MembersTab({ familyId, onLeft, onAddGroup }: { familyId: string; onLeft: () => void; onAddGroup?: () => void }) {
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
      <button
        onClick={() => setRenaming(true)}
        className="flex w-full items-center gap-2 card px-4 py-3 text-left active:opacity-80"
      >
        <Pencil size={ICON.action} className="shrink-0 text-muted" />
        <span className="flex-1 truncate font-medium">{config?.familyName || t('Семья')}</span>
        <span className="text-sm text-muted">{t('Переименовать')}</span>
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
        <PhoneOff size={ICON.action} className="shrink-0 text-muted" />
        <span className="flex-1 truncate font-medium">{t('Почему звонок не вышел')}</span>
        <ChevronRight size={ICON.action} className="shrink-0 text-muted" />
      </button>

      <div className="divide-y divide-hairline overflow-hidden card">
        {alive.map((m) => (
          <div key={m.id} className="flex w-full items-center gap-3 p-3">
            <button
              onClick={() => {
                if (m.id === selfId) setEditName(true);
              }}
              className="flex min-w-0 flex-1 items-center gap-3 text-left active:opacity-80"
            >
              <span className="relative shrink-0">
                <span
                  className="flex size-9 items-center justify-center rounded-full text-sm font-semibold text-white"
                  style={{ background: m.color }}
                >
                  {m.displayName.slice(0, 1).toUpperCase()}
                </span>
                {/* У себя — тоже по списку сервера, без поблажки «я всегда в
                    сети»: он включает и это устройство, пока оно на связи.
                    Раньше точка горела и без сети, рядом с «не в сети» в шапке. */}
                {onlineSet.has(m.id) && (
                  <span data-testid="presence-dot" className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-success ring-2 ring-surface" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">
                <span className={m.removedAt ? 'line-through opacity-60' : undefined}>{m.displayName}</span>
                {m.id === selfId ? (
                  <span className="text-muted"> · {t('вы')}</span>
                ) : m.removedAt ? (
                  <span className="text-xs text-muted"> · {t('исключён')}</span>
                ) : (
                  <span className="text-xs text-muted"> · {onlineSet.has(m.id) ? t('в сети') : t('не в сети')}</span>
                )}
              </span>
            </button>
            {m.id !== selfId && !m.removedAt && (
              <>
                {isOwner && (
                  <button
                    onClick={() => setRemoving(m)}
                    aria-label={t('Исключить {name}', { name: m.displayName })}
                    className={`flex size-10 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger active:scale-95 ${HIT_SLOP_44}`}
                  >
                    <UserMinus size={ICON.base} />
                  </button>
                )}
                <button
                  onClick={() => void callManager.startCall(familyId, m.id)}
                  aria-label={t('Позвонить {name}', { name: m.displayName })}
                  className={`flex size-10 shrink-0 items-center justify-center rounded-full bg-success/15 text-success active:scale-95 ${HIT_SLOP_44}`}
                >
                  <Phone size={ICON.base} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {ownerless && (
        <div className="card p-4">
          <p className="font-semibold">{t('У группы нет владельца')}</p>
          <p className="mt-0.5 text-sm leading-relaxed text-muted">
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
          <Plus size={ICON.action} className="shrink-0 text-muted" />
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

      <button onClick={() => void leave()} className="flex w-full items-center justify-center gap-2 pt-2 text-sm text-danger active:opacity-60">
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
        <ul className="space-y-2 text-sm leading-snug text-text/90">
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
          className="w-full bg-danger-fill text-white"
          disabled={busy || !plan}
          onClick={() => void confirm()}
        >
          {busy ? t('Исключаем…') : t('Исключить')}
        </Button>
        <button onClick={onClose} className="w-full py-2 text-sm text-muted active:opacity-60">
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
