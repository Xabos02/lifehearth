import type { LucideIcon } from 'lucide-react';
// Глифы собственные (см. components/ui/glyphs.tsx): реестр разделов кормит
// иконками и таб-бар, и плитки «Главной» — то есть ровно те два места, где
// набор виден постоянно и любая лишняя деталь читается как шум.
import {
  GSun as Sun,
  GTasks as ListTodo,
  GNotes as NotebookText,
  GFamily as Users,
  GHome as House,
  GCalendar as CalendarDays,
  GSparkle as Sparkles,
  GTimer as Timer,
  GHabits as CalendarCheck,
  GTarget as Target,
  GLearning as GraduationCap,
  GFinance as Wallet,
  GEnergy as BatteryCharging,
  GPlaces as MapPin,
  GStats as ChartColumnBig,
  GDrop as Droplet,
  GHeart as Heart,
  GBot as Bot,
  GSettings as SettingsIcon,
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
  end?: boolean; // точное совпадение маршрута для активной подсветки NavLink
  /** «Главная» — контейнер: всегда ПЕРВЫЙ слот панели, не прячется и не входит
   *  в собственный список. */
  anchor?: boolean;
  /** Нельзя спрятать (Сегодня — стартовый экран, Настройки — вход в саму настройку). */
  nonHideable?: boolean;
  /** Не показывать, пока человек сам не включит (см. navLayout). */
  hiddenByDefault?: boolean;
  /** Подпись в списке «Главной» (у Сегодня/Задач/Заметок/Семьи её не показываем). */
  subtitle?: string;
}

export const SECTIONS: Section[] = [
  { id: 'today', label: 'Сегодня', to: '/', icon: Sun, end: true, nonHideable: true },
  {
    id: 'calendar',
    label: 'Календарь',
    to: '/calendar',
    icon: CalendarDays,
    subtitle: 'События и расписание',
  },
  { id: 'tasks', label: 'Задачи', to: '/tasks', icon: ListTodo },
  { id: 'notes', label: 'Заметки', to: '/notes', icon: NotebookText, subtitle: 'Быстрые записи и списки' },
  { id: 'family', label: 'Семья', to: '/more/family', icon: Users, subtitle: 'Общие задачи, чат и звонки' },
  {
    id: 'capture',
    label: 'Захват',
    to: '/share',
    icon: Sparkles,
    subtitle: 'Вставить текст → задача или заметка',
  },
  { id: 'focus', label: 'Фокус', to: '/more/focus', icon: Timer, subtitle: 'Таймер помодоро' },
  {
    id: 'habits',
    label: 'Привычки',
    to: '/more/habits',
    icon: CalendarCheck,
    subtitle: 'Ежедневные ритуалы и серии',
  },
  { id: 'goals', label: 'Цели', to: '/goals', icon: Target, subtitle: 'Большие цели и прогресс' },
  {
    id: 'learning',
    label: 'Обучение',
    to: '/more/learning',
    icon: GraduationCap,
    subtitle: 'Книги, курсы и языки',
  },
  { id: 'finance', label: 'Финансы', to: '/more/finance', icon: Wallet, subtitle: 'Траты и доходы' },
  {
    id: 'energy',
    label: 'Энергия',
    to: '/more/energy',
    icon: BatteryCharging,
    subtitle: 'Уровень сил и что восстанавливает',
  },
  {
    id: 'health',
    label: 'Здоровье',
    to: '/more/health',
    icon: Heart,
    subtitle: 'Тренировки и замеры',
  },
  {
    id: 'places',
    label: 'Места',
    to: '/more/places',
    icon: MapPin,
    subtitle: 'Советы, идеи, рекомендации',
  },
  { id: 'stats', label: 'Статистика', to: '/stats', icon: ChartColumnBig, subtitle: 'Обзор продуктивности' },
  // Подпись нейтральная намеренно: список разделов видно с чужого плеча чаще,
  // чем содержимое самого раздела. Кому раздел не нужен — прячет его через
  // «Настроить разделы», как любой другой.
  {
    id: 'cycle',
    label: 'Женские дни',
    to: '/more/cycle',
    icon: Droplet,
    subtitle: 'Цикл, самочувствие и прогноз',
    hiddenByDefault: true,
  },
  // Раздел «ИИ» существует в реестре только при включённом флаге (Настройки):
  // фича дописывается, и до готовности её не видно ни в панели, ни в списке
  // «Главной», ни в «Настроить разделы» — как «Женские дни» при мужском профиле.
  {
    id: 'ai',
    label: 'ИИ',
    to: '/more/ai',
    icon: Bot,
    subtitle: 'Чат с языковой моделью',
  },
  {
    id: 'settings',
    label: 'Настройки',
    to: '/more/settings',
    icon: SettingsIcon,
    nonHideable: true,
    subtitle: 'Копии, синхронизация, оформление',
  },
  // Якорь панели. Раньше это была «Ещё» — свалка того, что не влезло в нижний
  // ряд. Теперь это «Главная»: профиль, состояние данных, все разделы и
  // настройки в одном месте. Стоит первой вкладкой, а не последней, потому что
  // это точка входа, а не хвост списка.
  { id: 'home', label: 'Главная', to: '/home', icon: House, end: true, anchor: true },
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
export function sectionsFor(gender: 'female' | 'male' | undefined, aiEnabled?: boolean): Section[] {
  return SECTIONS.filter(
    (s) => (s.id !== 'cycle' || cycleAllowed(gender)) && (s.id !== 'ai' || aiEnabled),
  );
}

/** Сколько пользовательских разделов помещается в панель слева от «Главной». */
export const MAX_BOTTOM = 4;

/** Раскладка по умолчанию: что стоит в панели (без «Главной» — он добавляется как якорь). */
// Календарь вместо «Семьи» по умолчанию: до сих пор экран календаря вообще не
// имел ссылки в интерфейсе — попасть на него можно было только вводом адреса.
// «Семья» никуда не делась, она в списке «Главной» и возвращается в панель
// одним движением через «Настроить разделы».
export const DEFAULT_BOTTOM: SectionId[] = ['today', 'tasks', 'notes', 'calendar'];

/** id «Главная» — единственный жёсткий якорь панели (последний слот). */
export const ANCHOR_ID: SectionId = 'home';
