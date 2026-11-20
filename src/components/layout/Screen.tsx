import { useEffect } from 'react';
import { markFillScreen } from '../../lib/ui/fillScreen';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { useNavLayout } from '../../hooks/useNavLayout';
import {
  GChevronLeft as ChevronLeft,
  GChevronDown as ChevronDown,
} from '../../components/ui/glyphs';
import { t } from '../../lib/i18n';
import { IconButton } from '../ui/IconButton';
import { ICON, STROKE_STRONG } from '../ui/icons';

interface Props {
  title: string;
  /** маршрут «назад»; если задан — слева появляется стрелка */
  backTo?: string;
  /** Выход «назад» для экранов, которые не маршрут, а состояние внутри
   *  страницы (перенос заметки в папку). Для них backTo не годится: ссылка на
   *  собственный адрес компонент не размонтирует, состояние остаётся, и
   *  стрелка выглядит рабочей, ничего не делая. */
  onBack?: () => void;
  /** Подпись рядом со стрелкой — КУДА она ведёт: «Заметки», имя папки.
   *
   *  Нужна экранам без собственного заголовка. У редактора заметки его роль
   *  играет первая строка текста, поэтому title пустой, — и в шапке оставалась
   *  одна голая стрелка без единого слова. В iOS на этом месте всегда стоит имя
   *  родителя («‹ Все заметки»): оно и объясняет, куда вернёшься, и не спорит с
   *  заголовком самой заметки, потому что набрано обычным кеглем. */
  backLabel?: string;
  /** слот справа в шапке (кнопки) */
  right?: ReactNode;
  /** подзаголовок под title (например, дата) */
  subtitle?: string;
  /** Подзаголовок с разметкой (цвет статуса в шапке чата). Важнее subtitle,
   *  только в шапке с нажимаемым заголовком. */
  subtitleNode?: ReactNode;
  /** Строка НАД заголовком — дата на «Сегодня» (макет: дата мелко, крупно —
   *  приветствие). */
  eyebrow?: string;
  /** Скрытое начало заголовка для диктора и поиска по экрану: визуально
   *  приветствие, а по смыслу экран — «Сегодня». */
  titleHiddenPrefix?: string;
  /** контент занимает всю высоту (для чата): сам скроллится внутри, без резерва снизу */
  fill?: boolean;
  /** Минималистичная шапка: заголовок в одну строку обычным кеглем.
   *
   *  Для экранов, где шапка — не главное на экране, а служебная полоса над
   *  содержимым (чат). Крупный двухстрочный заголовок вместе с чипами групп и
   *  вкладками съедал там треть высоты, и переписке оставалось три сообщения. */
  compact?: boolean;
  /** Аватар перед заголовком — шапка чата, как в мессенджерах. */
  titleLead?: ReactNode;
  /** Нажатие на заголовок (с аватаром и подзаголовком) — карточка чата.
   *  Кнопка лежит внутри h1, а не наоборот: заголовок внутри кнопки —
   *  недопустимая разметка, и экранный диктор теряет его как заголовок. */
  onTitlePress?: () => void;
  /** Куда ведёт эта кнопка — для диктора, скрытым текстом после заголовка.
   *  Не aria-label: он заменил бы всё имя кнопки, и диктор перестал бы
   *  читать подзаголовок (статус связи). */
  titlePressHint?: string;
  /** Крупный заголовок-переключатель со стрелкой ⌄ (заметки: «Заметки ⌄» —
   *  выбор папки). Место в шапке не тратится: переключатель и есть заголовок,
   *  как выбор альбома в «Фото» или папок в Telegram. */
  onTitleMenu?: () => void;
  titleMenuOpen?: boolean;
  children: ReactNode;
}

/** Каркас страницы: липкая шапка с safe-area + контент с небольшим нижним
 *  отступом.
 *
 *  16px — нижняя граница воздуха. Без неё последняя карточка упиралась в низ
 *  ленты вплотную (замеры: зазор 0.0-0.3px, на 375px даже -0.5/-0.8px — нижний
 *  бордер срезался краем скролл-контейнера, потому что при root 17px размеры
 *  дробные и низ ленты попадает между пикселями). Плюс тень карточки
 *  (0 8px 24px -12px) рисуется ниже бордера и без запаса обрезалась целиком.
 *
 *  Место под плавающую кнопку сюда НЕ добавляется: его держит полоса самой
 *  ленты (App.tsx, --fab-strip), и складывать их значило бы вернуть мёртвую
 *  полосу внизу. Высоту таб-бара и safe-area — тоже: таб-бар соседний
 *  flex-элемент каркаса, а не наложение, свою safe-area он держит сам. */
/** Имя родителя по адресу «назад» — подпись у стрелки («‹ Ещё»), когда
 *  экран не задал свою. Ключи — русские (t() переводит). */
const PARENT_LABELS: Record<string, string> = {
  '/': 'Сегодня',
  '/home': 'Ещё',
  '/tasks': 'Задачи',
  '/notes': 'Заметки',
  '/goals': 'Цели',
  '/more/family': 'Семья',
  '/more/cycle': 'Женские дни',
  '/more/cycle/settings': 'Настройки раздела',
  '/more/learning': 'Обучение',
  '/more/settings': 'Настройки',
};

/** Стрелка «Назад» с необязательной подписью. */
function BackControl({ to, onClick, label }: { to?: string; onClick?: () => void; label?: string }) {
  if (!label) {
    return (
      <IconButton
        icon={ChevronLeft}
        label={t('Назад')}
        {...(onClick ? { onClick } : { to })}
        size={ICON.accent}
        strokeWidth={STROKE_STRONG}
      />
    );
  }
  // -ml-1 повторяет отступ IconButton: без него подписанная стрелка стояла бы
  // на 4px правее обычной, и шапка прыгала бы при переходе между экранами.
  const cls =
    'relative -ml-1 flex min-h-11 shrink-0 items-center gap-1 pr-1 text-base text-lh-accent active:opacity-60';
  const inner = (
    <>
      <ChevronLeft size={ICON.accent} strokeWidth={STROKE_STRONG} className="shrink-0" />
      {/* max-w — чтобы длинное имя папки не съедало место у кнопок справа. */}
      <span className="max-w-[12rem] truncate">{label}</span>
    </>
  );
  return onClick ? (
    <button type="button" aria-label={t('Назад: {label}', { label })} onClick={onClick} className={cls}>
      {inner}
    </button>
  ) : (
    <Link to={to!} aria-label={t('Назад: {label}', { label })} className={cls}>
      {inner}
    </Link>
  );
}

export function Screen({
  title,
  backTo: backToProp,
  onBack,
  backLabel,
  right,
  subtitle,
  subtitleNode,
  eyebrow,
  titleHiddenPrefix,
  fill = false,
  compact = false,
  titleLead,
  onTitlePress,
  titlePressHint,
  onTitleMenu,
  titleMenuOpen = false,
  children,
}: Props) {
  // Раздел, вынесенный в нижнее меню, — экран первого уровня: стрелка «‹ Ещё»
  // у него вводила бы в заблуждение (по умолчанию так у «Семьи»). Решает
  // текущая раскладка меню — человек может поменять её в «Разделах».
  const { bottom } = useNavLayout();
  const { pathname } = useLocation();
  const backTo =
    backToProp === '/home' && bottom.some((sec) => !sec.anchor && sec.to === pathname) ? undefined : backToProp;
  // Пока такой экран открыт, баннер установки не показывается: прокрутки,
  // вместе с которой он уезжал бы, здесь нет.
  useEffect(() => (fill ? markFillScreen() : undefined), [fill]);
  return (
    // Место под плавающую кнопку — здесь, в конце самого экрана.
    //
    // shrink-0 обязателен, и это главное. Обёртка ленты (App.tsx) — flex-
    // контейнер фиксированной высоты, а этот блок в ней — flex-элемент, и по
    // умолчанию flex-элемент УЖИМАЕТСЯ до высоты контейнера: замерено —
    // блок 510px, его содержимое 1513px и просто вылезает наружу. Из-за этого
    // любой нижний отступ — на скроллере, распоркой после обёртки, здесь —
    // оказывался на 480px выше конца контента, и последняя кнопка экрана
    // всё равно уезжала под «+». Три подхода подряд не сработали ровно по
    // этой причине. С shrink-0 блок растёт по содержимому, и отступ честно
    // встаёт в конец. На экранах без кнопки переменная нулевая — остаётся
    // обычный pb-4.
    <div
      className={fill ? 'flex h-full flex-col' : 'min-h-full shrink-0'}
      style={fill ? undefined : { paddingBottom: 'calc(1rem + var(--fab-strip, 0px))' }}
    >
      {/* Широкие экраны (Mac/Windows/iPad): контент — центральная колонка
          max-w-lg, той же ширины, что таб-бар. На телефоне ничего не меняет. */}
      {/* Шапка «Ember Gold» (редизайн 42 экранов): без нижней линии, на
          полупрозрачном фоне с blur — контент уходит под неё мягко. У экранов
          второго уровня стрелка с именем родителя стоит отдельной строкой над
          крупным заголовком, как large title в iOS; у корневых — заголовок
          слева, действия справа. Компактная (чат) — одна строка, как раньше. */}
      <header
        className={`sticky top-0 z-30 shrink-0 bg-[color-mix(in_srgb,var(--lh-bg)_92%,transparent)] px-4 backdrop-blur-[20px] ${
          compact
            ? 'border-b border-lh-border pt-[calc(env(safe-area-inset-top)+8px)] pb-2'
            : 'pt-[calc(env(safe-area-inset-top)+8px)] pb-3'
        }`}
      >
        {!compact && !onTitlePress && (backTo || onBack) ? (
          <div className="mx-auto w-full max-w-lg">
            <div className="-ml-1 flex min-h-11 items-center gap-2">
              <BackControl to={backTo} onClick={onBack} label={backLabel ?? (backTo && PARENT_LABELS[backTo] ? t(PARENT_LABELS[backTo]) : t('Назад'))} />
              <div className="ml-auto flex items-center">{right}</div>
            </div>
            {(title || subtitle) && (
              <div className="pt-1">
                {title && <h1 className="lh-heading line-clamp-2 break-words max-[359px]:text-[7.5vw]">{title}</h1>}
                {subtitle && <p className="mt-1 text-xs text-lh-text-secondary">{subtitle}</p>}
              </div>
            )}
          </div>
        ) : (
        <div className="mx-auto flex w-full max-w-lg items-center gap-2">
          {(backTo || onBack) && (
            <BackControl to={backTo} onClick={onBack} label={compact ? backLabel : undefined} />
          )}
          {onTitlePress ? (
            <h1 className="min-w-0 flex-1">
              <button
                type="button"
                onClick={onTitlePress}
                className="flex min-h-11 w-full min-w-0 items-center gap-2.5 text-left active:opacity-70"
              >
                {titleLead}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base leading-tight font-semibold tracking-tight text-lh-text-primary">
                    {title}
                  </span>
                  {subtitleNode ? (
                    <span className="block truncate text-xs leading-tight text-lh-text-secondary">{subtitleNode}</span>
                  ) : (
                    subtitle && (
                      <span className="block truncate text-2xs leading-tight font-medium text-lh-text-secondary">{subtitle}</span>
                    )
                  )}
                  {titlePressHint && <span className="sr-only">{titlePressHint}</span>}
                </span>
              </button>
            </h1>
          ) : (
          <div className={`min-w-0 flex-1 ${compact ? '' : 'pt-1'}`}>
            {/* Пустой заголовок — законный случай (редактор заметки): пустой h1
                не рендерим, он раздувал бы шапку. */}
            {eyebrow && !compact && <p className="mb-1 text-sm text-lh-text-secondary">{eyebrow}</p>}
            {title && (
              <h1
                className={
                  compact
                    ? 'truncate text-base leading-tight font-semibold tracking-tight text-lh-text-primary'
                    : // У переключателя обрезку несёт имя внутри кнопки: line-clamp на h1
                      // с inline-flex внутри срезал бы стрелку вместе со второй строкой.
                      `lh-heading break-words max-[359px]:text-[7.5vw] ${onTitleMenu ? '' : 'line-clamp-2'}`
                }
              >
                {titleHiddenPrefix && <span className="sr-only">{titleHiddenPrefix}. </span>}
                {onTitleMenu && !compact ? (
                  <button
                    type="button"
                    onClick={onTitleMenu}
                    aria-haspopup="dialog"
                    aria-expanded={titleMenuOpen}
                    // Зона 44px — псевдоэлементом: min-h-11 раздувал шапку на 12px,
                    // и лента прыгала бы при входе в режим выбора.
                    className="relative flex max-w-full items-center gap-1.5 text-left after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] active:opacity-70"
                  >
                    <span className="line-clamp-2 min-w-0 break-words">{title}</span>
                    <ChevronDown
                      size={ICON.header}
                      strokeWidth={STROKE_STRONG}
                      aria-hidden
                      className={`shrink-0 text-lh-accent transition-transform duration-200 ${titleMenuOpen ? 'rotate-180' : ''}`}
                    />
                  </button>
                ) : (
                  title
                )}
              </h1>
            )}
            {subtitle && (
              <p className={`text-lh-text-secondary ${compact ? 'truncate text-2xs leading-tight font-medium' : 'mt-1 text-xs'}`}>
                {subtitle}
              </p>
            )}
          </div>
          )}
          {right && <div className="-mr-2 flex shrink-0 items-center">{right}</div>}
        </div>
        )}
      </header>
      <main
        className={
          fill
            ? 'mx-auto min-h-0 w-full max-w-lg flex-1 overflow-hidden px-4 pt-4'
            : 'mx-auto w-full max-w-lg px-4 pt-4'
        }
      >
        {children}
      </main>
    </div>
  );
}
