import type { LucideIcon } from 'lucide-react';
// Значки разделов — Font Awesome Free 6.5.1 из макетов Abacus (PROTOCOL §20),
// пути перенесены в components/ui/glyphs.tsx. Реестр кормит ими все места,
// где виден раздел: нижнее меню, «Ещё», «Настроить разделы», первый запуск,
// «Поиск», корзину — поэтому у раздела везде один рисунок.
import {
  GFaSun,
  GFaSunSolid,
  GFaSquareCheck,
  GFaSquareCheckSolid,
  GFaNoteSticky,
  GFaNoteStickySolid,
  GFaComments,
  GFaCommentsSolid,
  GFaEllipsis,
  GFaCalendar,
  GFaCalendarSolid,
  GFaClipboard,
  GFaClipboardSolid,
  GFaHourglass,
  GFaHourglassSolid,
  GFaArrowsRotate,
  GFaFlag,
  GFaFlagSolid,
  GFaBookOpen,
  GFaWallet,
  GFaBolt,
  GFaHeart,
  GFaHeartSolid,
  GFaLocationDot,
  GFaChartSimple,
  GFaDroplet,
  GFaWandSparkles,
  GFaGear,
} from '../components/ui/glyphs';

// Единый реестр разделов навигации. Раньше данные были разбросаны между TabBar
// и MorePage; теперь один источник, из которого собираются и нижняя панель, и
// список «Главной», и экран настройки. Пользователь перекладывает разделы между
// панелью и «Главной» и прячет ненужные — раскладка живёт в settings (device-local).

export type SectionId =
  | 'today'
  | 'tasks'
  | 'notes'
  | 'family'
  | 'home'
  | 'capture'
  | 'focus'
  | 'habits'
  | 'goals'
  | 'learning'
  | 'finance'
  | 'energy'
  | 'health'
  | 'places'
  | 'stats'
  | 'calendar'
  | 'cycle'
  | 'ai'
  | 'settings';

export interface Section {
  id: SectionId;
  label: string; // короткая метка (нижняя панель)
  to: string; // маршрут
  icon: LucideIcon;
  /** Значок активной вкладки, если он не тот же рисунок потолще. */
  activeIcon?: LucideIcon;
  end?: boolean; // точное совпадение маршрута для активной подсветки NavLink
  /** «Главная» — контейнер: всегда ПЕРВЫЙ слот панели, не прячется и не входит
   *  в собственный список. */
  anchor?: boolean;
  /** Нельзя спрятать (Сегодня — стартовый экран, Настройки — вход в саму настройку). */
  nonHideable?: boolean;
  /** Не показывать, пока человек сам не включит (см. navLayout). */
  hiddenByDefault?: boolean;
  /** Новинка — первой на «Главной», пока человек её не расставлял (см. navLayout). */
  featured?: boolean;
  /** Подпись в списке «Главной» (у Сегодня/Задач/Заметок/Семьи её не показываем). */
  subtitle?: string;
}

export const SECTIONS: Section[] = [
  { id: 'today', label: 'Сегодня', to: '/', icon: GFaSun, activeIcon: GFaSunSolid, end: true, nonHideable: true },
  {
    id: 'calendar',
    label: 'Календарь',
    to: '/calendar',
    icon: GFaCalendar, activeIcon: GFaCalendarSolid,
    subtitle: 'События и расписание',
  },
  { id: 'tasks', label: 'Задачи', to: '/tasks', icon: GFaSquareCheck, activeIcon: GFaSquareCheckSolid },
  { id: 'notes', label: 'Заметки', to: '/notes', icon: GFaNoteSticky, activeIcon: GFaNoteStickySolid, subtitle: 'Быстрые записи и списки' },
  { id: 'family', label: 'Семья', to: '/more/family', icon: GFaComments, activeIcon: GFaCommentsSolid, subtitle: 'Общие задачи, чат и звонки' },
  {
    id: 'capture',
    label: 'Захват',
    to: '/share',
    icon: GFaClipboard, activeIcon: GFaClipboardSolid,
    subtitle: 'Вставить текст → задача или заметка',
  },
  { id: 'focus', label: 'Фокус', to: '/more/focus', icon: GFaHourglass, activeIcon: GFaHourglassSolid, subtitle: 'Таймер помодоро' },
  {
    id: 'habits',
    label: 'Привычки',
    to: '/more/habits',
    icon: GFaArrowsRotate,
    subtitle: 'Ежедневные ритуалы и серии',
  },
  { id: 'goals', label: 'Цели', to: '/goals', icon: GFaFlag, activeIcon: GFaFlagSolid, subtitle: 'Большие цели и прогресс' },
  {
    id: 'learning',
    label: 'Обучение',
    to: '/more/learning',
    icon: GFaBookOpen,
    subtitle: 'Книги, курсы и языки',
  },
  { id: 'finance', label: 'Финансы', to: '/more/finance', icon: GFaWallet, subtitle: 'Траты и доходы' },
  {
    id: 'energy',
    label: 'Энергия',
    to: '/more/energy',
    icon: GFaBolt,
    subtitle: 'Уровень сил и что восстанавливает',
  },
  {
    id: 'health',
    label: 'Здоровье',
    to: '/more/health',
    icon: GFaHeart, activeIcon: GFaHeartSolid,
    subtitle: 'Тренировки и замеры',
  },
  {
    id: 'places',
    label: 'Места',
    to: '/more/places',
    icon: GFaLocationDot,
    subtitle: 'Советы, идеи, рекомендации',
  },
  { id: 'stats', label: 'Статистика', to: '/stats', icon: GFaChartSimple, subtitle: 'Обзор продуктивности' },
  // Подпись нейтральная намеренно: список разделов видно с чужого плеча чаще,
  // чем содержимое самого раздела. Кому раздел не нужен — прячет его через
  // «Настроить разделы», как любой другой.
  {
    id: 'cycle',
    label: 'Женские дни',
    to: '/more/cycle',
    icon: GFaDroplet,
    subtitle: 'Цикл, самочувствие и прогноз',
    hiddenByDefault: true,
  },
  // Раздел «ИИ» до 1.69.0 был за флагом в Настройках; с запуска бесплатного
  // ассистента — обычный раздел, прячется через «Настроить разделы». Новинка:
  // первый на «Главной», пока человек его сам не переставил.
  {
    id: 'ai',
    label: 'ИИ',
    to: '/more/ai',
    icon: GFaWandSparkles,
    subtitle: 'Чат с языковой моделью',
    featured: true,
  },
  {
    id: 'settings',
    label: 'Настройки',
    to: '/more/settings',
    icon: GFaGear,
    nonHideable: true,
    subtitle: 'Копии, синхронизация, оформление',
  },
  // Якорь панели. Раньше это была «Ещё» — свалка того, что не влезло в нижний
  // ряд. Теперь это «Главная»: профиль, состояние данных, все разделы и
  // настройки в одном месте. Стоит первой вкладкой, а не последней, потому что
  // это точка входа, а не хвост списка.
  // Редизайн «Ember Gold» (15.11.2026): якорь снова «Ещё» и стоит ПОСЛЕДНИМ —
  // нижнее меню «Сегодня · Задачи · Заметки · Семья · Ещё» с подписями. Экран
  // тот же (/home): профиль, состояние данных, все разделы и настройки.
  { id: 'home', label: 'Ещё', to: '/home', icon: GFaEllipsis, end: true, anchor: true },
];

export const SECTION_BY_ID = new Map<string, Section>(SECTIONS.map((s) => [s.id, s]));

/** Доступен ли раздел «Женские дни» при этом поле. Пол не выбран — недоступен:
 *  гейт первого запуска всё равно не пустит дальше без выбора, а до его ответа
 *  раздел не должен мелькать нигде. */
export function cycleAllowed(gender: 'female' | 'male' | undefined): boolean {
  return gender === 'female';
}

/** Реестр разделов с учётом пола. Единственная точка, где раздел «Женские
 *  дни» исключается целиком: навигация, настройка разделов и всё, что строится
 *  из реестра, обязаны идти через эту функцию, а не через SECTIONS напрямую —
 *  иначе раздел «протечёт» в какой-нибудь список у мужского профиля. */
export function sectionsFor(gender: 'female' | 'male' | undefined): Section[] {
  return SECTIONS.filter((s) => s.id !== 'cycle' || cycleAllowed(gender));
}

/** Сколько пользовательских разделов помещается в панель слева от «Главной». */
export const MAX_BOTTOM = 4;

/** Сколько разделов показывается на «Главной» сразу, без разворачивания, и по
 *  сколько добавляется за одно нажатие «Показать ещё». Список «Главной» и так
 *  отсортирован по приоритету человека (см. «Настроить разделы»), поэтому
 *  первые HOME_VISIBLE_STEP — это и есть самые ходовые для него разделы. */
export const HOME_VISIBLE_STEP = 5;

/** Раскладка по умолчанию: что стоит в панели (без «Главной» — он добавляется как якорь). */
// Календарь вместо «Семьи» по умолчанию: до сих пор экран календаря вообще не
// имел ссылки в интерфейсе — попасть на него можно было только вводом адреса.
// «Семья» никуда не делась, она в списке «Главной» и возвращается в панель
// одним движением через «Настроить разделы».
// Редизайн 15.11.2026: «Семья» снова в панели (утверждённый эталон), а
// «Календарь» открывается кнопкой в шапке «Задач» и из «Ещё».
export const DEFAULT_BOTTOM: SectionId[] = ['today', 'tasks', 'notes', 'family'];

/** id «Главная» — единственный жёсткий якорь панели (последний слот). */
export const ANCHOR_ID: SectionId = 'home';
