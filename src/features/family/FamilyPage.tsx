import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Screen } from '../../components/layout/Screen';
import { getFamilyConfig, listFamilyConfigs } from '../../lib/family/familyState';
import { FamilyOnboarding } from './FamilyOnboarding';
import { FamilyScreen, type GroupView } from './FamilyScreen';
import { ChatList } from './ChatList';
import { chatPath } from './chats';
import { t } from '../../lib/i18n';
import { useConsent } from '../../lib/consent';
import { ConsentPause } from '../onboarding/ConsentGate';

/**
 * «Семья» — как мессенджер: /more/family — список чатов, ?g=<группа> — её
 * чат, &t=tasks / &t=members — её задачи и карточка.
 *
 * ?g= обязан открывать именно чат: этот адрес собирает пуш (public/push-sw.js)
 * и поиск по приложению, и у не обновивших service worker он не изменится.
 */
export function FamilyPage() {
  const configs = useLiveQuery(() => listFamilyConfigs(), []);
  const consent = useConsent();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const g = sp.get('g');

  // Ссылка на группу, которой больше нет (вышли, удалили; старый пуш или
  // поиск) — адрес меняется на список: таб-бар читает адрес, и с ?g= он
  // прятался бы и над списком. Сверка с базой, а не только с configs: сразу
  // после создания группы переход на её чат может опередить liveQuery.
  useEffect(() => {
    if (!g || !configs || configs.some((c) => c.familyId === g)) return;
    let live = true;
    void getFamilyConfig(g).then((c) => {
      if (live && !c) navigate('/more/family', { replace: true });
    });
    return () => {
      live = false;
    };
  }, [g, configs, navigate]);

  if (!configs)
    return (
      <Screen title={t('Семья')} backTo="/home">
        <div />
      </Screen>
    );

  // Без согласия на внешнее семья на паузе целиком (задача 34, артборд «Семья
  // на паузе»): чат, задачи, звонки, участники и вход в группу — всё ходит на
  // сервер. Одна кнопка — то же окно; группа, ключи и переписка на месте.
  if (!consent) {
    return (
      <Screen title={t('Семья')} backTo="/home">
        {configs.length > 0 ? (
          <ConsentPause
            reason="family"
            title={t('Семья на паузе')}
            text={t('Чат, общие задачи и звонки выходят в сеть — для них нужно ваше согласие. Группа и переписка остаются на телефоне.')}
          />
        ) : (
          <ConsentPause
            reason="family"
            title={t('Семье нужно согласие')}
            text={t('Чат, общие задачи и звонки выходят в сеть. Согласие одно — на всё внешнее сразу.')}
          />
        )}
      </Screen>
    );
  }

  if (configs.length === 0) {
    return (
      <Screen title={t('Семья')} backTo="/home">
        <FamilyOnboarding onReady={(id) => navigate(chatPath(id), { replace: true })} />
      </Screen>
    );
  }

  const tab = sp.get('t');
  const view: GroupView = tab === 'tasks' || tab === 'members' ? tab : 'chat';
  // Группы по ссылке больше нет (удалили, вышли) — список, а не чужой чат.
  // Старые адреса «?t=…» без группы открывают первую, как раньше.
  const current = configs.find((c) => c.familyId === g) ?? (tab && !g ? configs[0] : undefined);
  if (!current) return <ChatList configs={configs} />;

  // key: смена группы полностью перемонтирует экран — чистый сброс подписок.
  return <FamilyScreen key={current.familyId} config={current} first={current.familyId === configs[0].familyId} view={view} />;
}
