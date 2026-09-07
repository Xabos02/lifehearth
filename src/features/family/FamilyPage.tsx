import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { SlidersHorizontal, type LucideIcon } from 'lucide-react';
import {
  GPlus as Plus,
} from '../../components/ui/glyphs';
import type { FamilyConfig } from '../../db/types';
import { Screen } from '../../components/layout/Screen';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { listFamilyConfigs } from '../../lib/family/familyState';
import { countUnread } from '../../lib/family/unread';
import { screenAction, subscribeScreenAction } from '../../lib/ui/screenAction';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { FamilyOnboarding, CreateFamilySheet, JoinFamilySheet } from './FamilyOnboarding';
import { FamilyScreen } from './FamilyScreen';
import { useFamilyStatusLine } from './useFamilyStatusLine';
import { CallButton } from './CallButton';
import { ManageGroupsSheet } from './ManageGroupsSheet';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

const ACTIVE_KEY = 'life-hub-active-family';

export function FamilyPage() {
  const configs = useLiveQuery(() => listFamilyConfigs(), []);
  const [sp, setSp] = useSearchParams();
  const [addMode, setAddMode] = useState<null | 'choose' | 'create' | 'join'>(null);
  const [manageOpen, setManageOpen] = useState(false);

  // Выбранная группа живёт в URL (?g=…): так переход по пуш-уведомлению (открыть
  // конкретный чат) надёжно переключает группу, даже если открыта другая.
  const select = (id: string) => {
    try {
      localStorage.setItem(ACTIVE_KEY, id);
    } catch {
      /* приватный режим */
    }
    setSp({ g: id }, { replace: true });
  };

  if (!configs)
    return (
      <Screen title={t('Семья')} backTo="/home">
        <div />
      </Screen>
    );

  if (configs.length === 0) {
    return (
      <Screen title={t('Семья')} backTo="/home">
        <FamilyOnboarding onReady={select} />
      </Screen>
    );
  }

  const ids = configs.map((c) => c.familyId);
  const fromUrl = sp.get('g');
  const fromLs = (() => {
    try {
      return localStorage.getItem(ACTIVE_KEY);
    } catch {
      return null;
    }
  })();
  const selected = fromUrl && ids.includes(fromUrl) ? fromUrl : fromLs && ids.includes(fromLs) ? fromLs : ids[0];
  const current = configs.find((c) => c.familyId === selected)!;

  return (
    <ScreenWithStatus current={current} selected={selected}>
      <div className="flex h-full flex-col">
        {/* Свитчер групп — только когда групп больше одной: при единственной
            группе пилюля с её именем дублировала заголовок экрана строкой ниже
            и вместе с остальной шапкой выталкивала ленту чата за экран.
            «Добавить группу» при этом живёт во вкладке «Участники». */}
        {configs.length > 1 && (
          <GroupSwitcher
            configs={configs}
            selected={selected}
            onSelect={select}
            onAdd={() => setAddMode('choose')}
            onManage={() => setManageOpen(true)}
          />
        )}
        <div className="min-h-0 flex-1">
          {/* key=selected: смена группы полностью перемонтирует экран (чистый
              сброс вкладки/подписок), без ручного разбора переходов. */}
          <FamilyScreen
            key={selected}
            familyId={selected}
            onAddGroup={() => setAddMode('choose')}
            onLeft={() => {
              const sib = ids.find((i) => i !== selected);
              if (sib) {
                select(sib);
              } else {
                try {
                  localStorage.removeItem(ACTIVE_KEY);
                } catch {
                  /* приватный режим */
                }
                setSp({}, { replace: true });
              }
            }}
          />
        </div>
      </div>

      <Sheet open={addMode === 'choose'} onClose={() => setAddMode(null)} title={t('Добавить группу')}>
        <div className="space-y-3 pb-2">
          <Button className="w-full" onClick={() => setAddMode('create')}>
            {t('Создать группу')}
          </Button>
          <Button variant="secondary" className="w-full" onClick={() => setAddMode('join')}>
            {t('Войти по приглашению')}
          </Button>
        </div>
      </Sheet>
      <CreateFamilySheet
        open={addMode === 'create'}
        onClose={() => setAddMode(null)}
        onReady={(id) => {
          setAddMode(null);
          select(id);
        }}
      />
      <JoinFamilySheet
        open={addMode === 'join'}
        onClose={() => setAddMode(null)}
        onReady={(id) => {
          setAddMode(null);
          select(id);
        }}
      />
      <ManageGroupsSheet open={manageOpen} onClose={() => setManageOpen(false)} configs={configs} />
    </ScreenWithStatus>
  );
}

/** Обёртка шапки: имя группы + статус соединения подзаголовком. Статус раньше
 *  занимал собственную строку в теле экрана (и ещё одну — счётчик «в сети»);
 *  подзаголовок сообщает то же самое, не отнимая у переписки ни пикселя. */
function ScreenWithStatus({
  current,
  selected,
  children,
}: {
  current: FamilyConfig;
  selected: string;
  children: ReactNode;
}) {
  const status = useFamilyStatusLine(selected);
  // Действие от открытой вкладки (сейчас это поиск на «Чате»): вкладка сама
  // объявляет о нём, шапка только показывает. Своя строка под такую кнопку
  // стоила бы переписке два десятка пикселей высоты.
  const action = useSyncExternalStore(subscribeScreenAction, screenAction, () => null);
  const ActionIcon = action?.icon as LucideIcon | undefined;
  return (
    <Screen
      title={current.familyName}
      subtitle={current.removedAt ? undefined : status}
      backTo="/home"
      right={
        // gap-3, а не gap-1: обе кнопки шириной 36px, но зона касания у каждой
        // расширена до 44 — то есть выходит на 4px за края. При зазоре в 4px
        // зоны смыкались, и палец над лупой попадал в звонок. Звонок — не та
        // кнопка, которую прощают за случайное нажатие: он поднимает трезвон у
        // человека на том конце. 12px дают 4px чистого зазора между зонами.
        <div className="flex items-center gap-3">
          {action && ActionIcon && (
            <button
              onClick={action.onPress}
              aria-label={action.label}
              className={`flex size-9 items-center justify-center rounded-full text-muted active:text-accent ${HIT_SLOP_44}`}
            >
              <ActionIcon size={ICON.header} />
            </button>
          )}
          <CallButton familyId={selected} />
        </div>
      }
      fill
    >
      {children}
    </Screen>
  );
}

function GroupSwitcher({
  configs,
  selected,
  onSelect,
  onAdd,
  onManage,
}: {
  configs: FamilyConfig[];
  selected: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onManage: () => void;
}) {
  // Считаем только сообщения после отметки прочтения. Полное чтение таблицы
  // поднимало бы сюда и фотографии, и голосовые — ради числа на кружке.
  const unread =
    useLiveQuery(async () => {
      const map: Record<string, number> = {};
      for (const c of configs) map[c.familyId] = await countUnread(c);
      return map;
    }, [configs]) ?? {};

  return (
    <div className="shrink-0 -mx-1 flex gap-2 overflow-x-auto px-1 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {configs.map((c) => {
        const active = c.familyId === selected;
        const n = unread[c.familyId] ?? 0;
        return (
          <button
            key={c.familyId}
            onClick={() => onSelect(c.familyId)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium active:opacity-80 ${
              active ? 'bg-accent-fill text-white' : 'bg-surface-2 text-muted'
            }`}
          >
            <span className="max-w-[9rem] truncate">{c.familyName || t('Семья')}</span>
            {n > 0 && (
              <span
                className={`flex min-w-[1.1rem] items-center justify-center rounded-full px-1 text-2xs font-bold leading-none ${
                  active ? 'bg-white/25 text-white' : 'bg-accent-fill text-white'
                }`}
              >
                {n > 99 ? '99+' : n}
              </span>
            )}
          </button>
        );
      })}
      <button
        onClick={onAdd}
        aria-label={t('Добавить группу')}
        className="flex size-8 shrink-0 items-center justify-center self-center rounded-full bg-surface-2 text-muted active:opacity-80"
      >
        <Plus size={ICON.base} />
      </button>
      {configs.length > 0 && (
        <button
          onClick={onManage}
          aria-label={t('Управление группами')}
          className="flex size-8 shrink-0 items-center justify-center self-center rounded-full bg-surface-2 text-muted active:opacity-80"
        >
          <SlidersHorizontal size={ICON.action} />
        </button>
      )}
    </div>
  );
}
