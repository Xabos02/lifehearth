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
  // таббара приложения под ним. Вкладка «Чат» — она же вкладка по умолчанию
  // (?t=tasks/members переключает на остальные, там таббар нужен).
  if (pathname === '/more/family' && new URLSearchParams(search).get('t') == null) return null;

  return (
    <nav className="z-30 shrink-0 border-t border-lh-border bg-[color-mix(in_srgb,var(--lh-bg)_92%,transparent)] backdrop-blur-[20px] pb-[clamp(6px,env(safe-area-inset-bottom),8px)]">
      <div className="mx-auto flex max-w-lg px-1">
        {bottom.map(({ id, to, label, icon: Icon, end }) => {
          // Бейджи привязаны к разделу, куда бы он ни встал: непрочитанное у
          // «Семьи», «пора сделать копию» у «Главной» (настройки живут там).
          const showBadge = (id === 'home' && backupStale) || (id === 'family' && familyUnread);
          return (
            <NavLink
              key={id}
              to={to}
              end={end}
              // Подписей под иконками нет (макеты) — имя вкладки живёт только
              // здесь. Оранжевая точка 8px несёт два разных сообщения; их
              // текстовый дубль тоже уходит в имя ссылки.
              aria-label={
                showBadge
                  ? `${t(label)}, ${id === 'home' ? t('нужна резервная копия') : t('есть непрочитанные')}`
                  : t(label)
              }
              // min-w-0 обязателен: без него flex-элемент не сжимается ниже
              // min-content содержимого, и пятая вкладка уезжает за край
              // экрана (с подписями на 320px ряд требовал 348px и обрезался).
              className="flex min-w-0 flex-1 flex-col items-center pt-2 pb-1.5"
            >
              {({ isActive }) => (
                <>
                  <span
                    // Пилюля тянется по вкладке, но не шире прежних w-16 (64px:
                    // шаг --spacing 4px × 16): на 393/430px вид не меняется, а на
                    // узком экране она сжимается вместо того, чтобы задавать
                    // неусыхаемый min-content и выталкивать ряд за край.
                    className={`flex h-9 w-full max-w-16 items-center justify-center rounded-2xl transition-colors duration-200 ${
                      isActive ? 'text-lh-accent' : 'text-lh-text-secondary'
                    }`}
                  >
                    <span className="relative shrink-0">
                      <Icon
                        size={ICON.header}
                        // Активная вкладка «наливается» весом. Раньше это
                        // делалось через inline style — единственный способ
                        // перебить глобальное .lucide{stroke-width}. Правила
                        // больше нет, вес идёт обычным пропом и означает
                        // пиксели (ui/icons.ts).
                        strokeWidth={isActive ? STROKE_STRONG : STROKE}
                      />
                      {showBadge && (
                        <span className="absolute -top-0.5 -right-1 size-2 rounded-full bg-warning ring-2 ring-lh-bg" />
                      )}
                    </span>
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
