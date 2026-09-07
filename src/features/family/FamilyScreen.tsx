import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  GClose as X,
  GBellRing as BellRing,
} from '../../components/ui/glyphs';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { registerAllFamilyPush } from '../../lib/family/familyChat';
import { getFamilyConfig } from '../../lib/family/familyState';
import { pushEnabled, pushSupported, isStandalone, enablePush } from '../../lib/push';
import { MembersTab } from './MembersTab';
import { ChatTab } from './ChatTab';
import { FamilyTasksTab } from './FamilyTasksTab';
import { useToast } from '../../components/ui/toastContext';
import { getLang, t } from '../../lib/i18n';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { ICON } from '../../components/ui/icons';

type Tab = 'chat' | 'tasks' | 'members';
const TABS = [
  { value: 'chat' as const, label: 'Чат' },
  { value: 'tasks' as const, label: 'Задачи' },
  { value: 'members' as const, label: 'Участники' },
];

export function FamilyScreen({ familyId, onLeft, onAddGroup }: { familyId: string; onLeft: () => void; onAddGroup?: () => void }) {
  const [tab, setTab] = useState<Tab>('chat');
  const config = useLiveQuery(() => getFamilyConfig(familyId), [familyId]);
  const toast = useToast();
  const [pushOn, setPushOn] = useState(pushEnabled());
  const [pushHidden, setPushHidden] = useState(false);

  async function enableFamilyPush() {
    if (!pushSupported()) {
      toast(t('Уведомления не поддерживаются этим браузером.'));
      return;
    }
    if (!isStandalone()) {
      toast(t('Уведомления работают только в установленном приложении. Добавьте LifeHearth на экран «Домой» и откройте оттуда.'));
      return;
    }
    const res = await enablePush();
    if (!res.ok) {
      toast(res.reason === 'denied' ? t('Разрешение не выдано. Включите в настройках устройства.') : t('Не удалось включить уведомления. Проверьте разрешения в настройках устройства'));
      return;
    }
    await registerAllFamilyPush();
    setPushOn(true);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-3 pb-3">
        {config?.removedAt ? (
          // Молчаливое «не в сети» тут было бы обманом: человек чинил бы связь,
          // которой больше нет. Переписку оставляем — она его, и стирать её
          // вдогонку к исключению незачем.
          <div className="rounded-xl bg-danger/10 p-3 text-sm leading-snug text-danger">
            {t('Вас исключили из этой группы. Переписка на этом устройстве осталась, но новые сообщения приходить не будут.')}
          </div>
        ) : null}
        {/* Статус соединения здесь больше не рендерится — он ушёл в подзаголовок
            шапки (useFamilyStatusLine): каждая служебная строка над чатом — это
            минус строка переписки на экране. */}
        {!pushOn && !pushHidden && (
          <div className="flex items-center gap-2 rounded-xl bg-accent/10 px-3 py-2 text-sm">
            <BellRing size={ICON.action} className="shrink-0 text-accent" />
            {/* Короткая формулировка намеренно: длинная растягивала баннер на
                три строки и вместе с остальной шапкой выталкивала чат за экран. */}
            <span className="min-w-0 flex-1">{t('Уведомления')}</span>
            {/* Зона касания у текстовой кнопки была 72×22 — вдвое ниже нормы.
                Расширяем невидимо: поднимать сам баннер нельзя, его высоту
                выгрызали ради строк переписки. */}
            <button
              onClick={() => void enableFamilyPush()}
              className={`shrink-0 font-semibold text-accent active:opacity-60 ${HIT_SLOP_44}`}
            >
              {/* «Включить» в словаре занято звуком чата ('Unmute') — здесь смысл
                  «разрешить уведомления», английская ветка явная. */}
              {getLang() === 'en' ? 'Turn on' : 'Включить'}
            </button>
            <button
              onClick={() => setPushHidden(true)}
              aria-label={t('Скрыть')}
              // ml-3, а не ml-1: у крестика зона расширена до 44 при ширине ~26,
              // то есть выходит на 9px за края — при зазоре 4px она залезала на
              // «Включить», и «скрыть» срабатывало вместо «разрешить».
              className={`ml-3 shrink-0 p-1.5 text-muted active:opacity-60 ${HIT_SLOP_44}`}
            >
              <X size={ICON.action} />
            </button>
          </div>
        )}
        <SegmentedControl options={TABS.map((o) => ({ ...o, label: t(o.label) }))} value={tab} onChange={setTab} />
      </div>
      {/* Для чата — без внешнего скролла (ChatTab имеет свой), иначе два
          вложенных overflow-y-auto давали «войну скроллов» и заморозку. */}
      <div className={`min-h-0 flex-1 ${tab === 'chat' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
        {tab === 'chat' ? (
          <ChatTab familyId={familyId} />
        ) : tab === 'tasks' ? (
          <FamilyTasksTab familyId={familyId} />
        ) : (
          <MembersTab familyId={familyId} onLeft={onLeft} onAddGroup={onAddGroup} />
        )}
      </div>
    </div>
  );
}
