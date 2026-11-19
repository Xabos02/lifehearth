import { useLiveQuery } from 'dexie-react-hooks';
import { NavLink, useLocation } from 'react-router';
import { isBackupDue } from '../../db/backup';
import { useFamilyUnread } from '../../hooks/useFamilyUnread';
import { useNavLayout } from '../../hooks/useNavLayout';
import { ICON, STROKE, STROKE_STRONG } from '../ui/icons';
import { t } from '../../lib/i18n';

export function TabBar() {
  const { pathname, search } = useLocation();
  const familyUnread = useFamilyUnread();
  // Состав и порядок вкладок — из раскладки «под себя» (экран «Настроить разделы»).
  const { bottom } = useNavLayout();
  // Правило одно с карточкой настроек на «Главной» — там эта точка и объяснена.
  const backupStale = useLiveQuery(() => isBackupDue(), []) ?? false;

  // На экране редактора заметки таб-бар скрыт — внизу панель форматирования.
  if (/^\/notes\/.+/.test(pathname)) return null;

  // Чат семьи — на весь экран, как переписка в мессенджере: без нижнего
  // таббара приложения под ним. Чат — это ?g=<группа> без ?t=; в списке
  // чатов, задачах и карточке группы таббар нужен.
  const familyQs = new URLSearchParams(search);
  if (pathname === '/more/family' && familyQs.get('g') != null && familyQs.get('t') == null) return null;

  return (
    // Редизайн «Ember Gold»: холст #111118 на 92% + blur, подписи 11px под
    // иконками, активная вкладка — золото и полужирная подпись. Зона касания
    // каждой вкладки — 52px в высоту и не уже пятой части ряда.
    <nav className="z-30 shrink-0 border-t border-lh-border bg-[color-mix(in_srgb,var(--lh-canvas)_92%,transparent)] backdrop-blur-[20px] pb-[clamp(6px,env(safe-area-inset-bottom),8px)]">
      <div className="mx-auto flex max-w-lg px-2 pt-1.5">
        {bottom.map(({ id, to, label, icon: Icon, activeIcon: ActiveIcon, end }) => {
          // Бейджи привязаны к разделу, куда бы он ни встал: непрочитанное у
          // «Семьи», «пора сделать копию» у «Ещё» (настройки живут там).
          const showBadge = (id === 'home' && backupStale) || (id === 'family' && familyUnread);
          return (
            <NavLink
              key={id}
              to={to}
              end={end}
              aria-label={
                showBadge
                  ? `${t(label)}, ${id === 'home' ? t('нужна резервная копия') : t('есть непрочитанные')}`
                  : undefined
              }
              // min-w-0 обязателен: без него пятая вкладка с подписью уезжала
              // за край на 320px.
              className="flex h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-1"
            >
              {({ isActive }) => (
                <>
                  <span className={`relative shrink-0 ${isActive ? 'text-lh-accent' : 'text-lh-text-secondary'}`}>
                    {isActive && ActiveIcon ? (
                      <ActiveIcon size={ICON.header} strokeWidth={STROKE_STRONG} />
                    ) : (
                      <Icon size={ICON.header} strokeWidth={isActive ? STROKE_STRONG : STROKE} />
                    )}
                    {showBadge && (
                      <span className="absolute -top-0.5 -right-1 size-2 rounded-full bg-warning ring-2 ring-lh-canvas" />
                    )}
                  </span>
                  <span
                    className={`max-w-full truncate text-2xs ${
                      isActive ? 'font-semibold text-lh-accent' : 'text-lh-text-secondary'
                    }`}
                  >
                    {t(label)}
                  </span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
