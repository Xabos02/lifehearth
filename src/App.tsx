import { Component, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { LucideProvider } from 'lucide-react';
import { db } from './db/db';
import { t } from './lib/i18n';
import { cycleAllowed } from './lib/sections';
import { STROKE } from './components/ui/icons';
import { InstallBanner } from './components/layout/InstallBanner';
import { ReloadPrompt } from './components/layout/ReloadPrompt';
import { SyncRunner } from './components/SyncRunner';
import { BackupRunner } from './components/BackupRunner';
import { PhotoMigrationRunner } from './components/PhotoMigrationRunner';
import { FamilyRunner } from './components/FamilyRunner';
import { CallRunner } from './components/CallRunner';
import { SwNavBridge } from './components/SwNavBridge';
import { TabBar } from './components/layout/TabBar';
import { ToastProvider } from './components/ui/Toast';
import { useSettings } from './hooks/useSettings';
import { TodayPage } from './features/today/TodayPage';
import { TasksPage } from './features/tasks/TasksPage';
import { GoalsPage } from './features/goals/GoalsPage';
import { GoalDetailPage } from './features/goals/GoalDetailPage';
import { HomePage } from './features/home/HomePage';
import { ProfilePage } from './features/home/ProfilePage';
import { NotesPage } from './features/notes/NotesPage';
import { NoteEditorPage } from './features/notes/NoteEditorPage';
import { LearningPage } from './features/learning/LearningPage';
import { FinancePage } from './features/finance/FinancePage';
import { EnergyPage } from './features/energy/EnergyPage';
import { HabitsPage } from './features/habits/HabitsPage';
import { PlacesPage } from './features/places/PlacesPage';
import { SearchPage } from './features/search/SearchPage';
import { SharePage } from './features/share/SharePage';
import { StatsPage } from './features/stats/StatsPage';
import { NotFoundPage } from './features/NotFoundPage';
import { CalendarPage } from './features/calendar/CalendarPage';
import { CyclePage } from './features/cycle/CyclePage';
import { CycleSettingsPage } from './features/cycle/CycleSettingsPage';
import { CycleYearPage } from './features/cycle/CycleYearPage';
import { CycleReportPage } from './features/cycle/CycleReportPage';
import { TrashPage } from './features/trash/TrashPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { InstallInstructionsPage } from './features/settings/InstallInstructionsPage';
import { BackupPage } from './features/settings/BackupPage';
import { SectionsSettingsPage } from './features/settings/SectionsSettingsPage';
import { FocusPage } from './features/focus/FocusPage';
import { FamilyPage } from './features/family/FamilyPage';
import { AiPage } from './features/ai/AiPage';
import { PomodoroProvider } from './features/focus/PomodoroProvider';
import { MiniTimer } from './features/focus/MiniTimer';
import { GenderGate } from './features/onboarding/GenderGate';
import { OnboardingOverlay } from './features/onboarding/OnboardingOverlay';
import { ReinstallNotice } from './features/onboarding/ReinstallNotice';
import { WhatsNew } from './features/onboarding/WhatsNew';

/** Маршруты раздела «Женские дни» существуют только в женском профиле. Прямой
 *  адрес (закладка, история браузера, ссылка из уведомления) у мужского — не
 *  ошибка 404, а тихий уход на «Главную»: сам факт «здесь что-то было» —
 *  информация, которую не надо показывать. Пока настройки не загружены, не
 *  рендерим ничего — иначе страница мигнёт до ответа Dexie. */
function RequireFemale({ children }: { children: ReactNode }) {
  const settings = useLiveQuery(() => db.settings.get('app'), []);
  if (settings === undefined) return null;
  if (!cycleAllowed(settings?.gender)) return <Navigate to="/home" replace />;
  return children;
}

/** Сбрасывает прокрутку контейнера наверх при смене маршрута — иначе открытая
 *  после прокрутки страница (например «Главная») показывалась не с начала. */
function ScrollReset() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.getElementById('app-scroll')?.scrollTo({ top: 0 });
  }, [pathname]);
  return null;
}

function ThemeApplier() {
  const { theme, accent } = useSettings();
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const light = theme === 'light' || (theme === 'system' && mq.matches);
      document.documentElement.classList.toggle('light', light);
    };
    apply();
    if (theme === 'system') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme]);
  useEffect(() => {
    // Индиго — отсутствие атрибута, а не значение: акцентные блоки в CSS
    // существуют только для не-дефолтных акцентов.
    if (accent && accent !== 'indigo') document.documentElement.dataset.accent = accent;
    else delete document.documentElement.dataset.accent;
  }, [accent]);
  return null;
}

/** Ловит throw при рендере любой страницы — вместо белого экрана показывает
 *  fallback с кнопкой перезагрузки. Данные в IndexedDB при этом целы. */
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-lg font-semibold">{t('Что-то пошло не так')}</p>
          <p className="text-sm text-muted">
            {t('Перезагрузите приложение — данные сохранены на устройстве.')}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-xl bg-accent-fill px-5 py-3 font-semibold text-white active:opacity-80"
          >
            {t('Перезагрузить')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      {/* absoluteStrokeWidth делит вес на размер иконки, поэтому STROKE — это
          настоящие пиксели штриха, одинаковые и на 14px, и на 40px. Без него
          один и тот же вес давал разброс почти втрое (см. ui/icons.ts). */}
      <LucideProvider absoluteStrokeWidth strokeWidth={STROKE}>
      <ToastProvider>
        <ThemeApplier />
        <ScrollReset />
        <SyncRunner />
        <BackupRunner />
        <PhotoMigrationRunner />
        <FamilyRunner />
        <CallRunner />
        <SwNavBridge />
        <PomodoroProvider>
        <ErrorBoundary>
          {/* Каркас прибит ко ВСЕМ четырём краям (inset-0) — гарантированно
              покрывает весь экран в standalone-PWA, без полосы-пустоты внизу
              (h-dvh с top-0 на iPhone до низа не доставал). Скроллится только
              контент; таб-бар — обычный flex-элемент в самом низу. bg-bg
              заливает весь каркас, включая safe-area под таб-баром. */}
          <div className="fixed inset-0 flex flex-col overflow-hidden bg-bg">
            {/* Аврора — неподвижный слой за контентом (не fixed-attachment) */}
            <div aria-hidden className="aurora pointer-events-none absolute inset-0 -z-10" />
            {/* Нижний отступ — полоса плавающей кнопки: пока она на экране,
                лента заканчивается ВЫШЕ неё, и под кнопкой остаётся фон
                каркаса. Иначе кнопка висит поверх ленты и ворует тапы у
                того, что под неё попало: на «Сегодня» это были «отправить»
                и микрофон строки быстрого ввода, крестик подсказки, кружок
                оценки энергии. Переменную выставляет сама кнопка (Fab.tsx),
                на экранах без неё полоса нулевая. margin, а не padding:
                padding оставил бы ленту прежней высоты и только добавил бы
                пустоту в её конец — кнопка по-прежнему стояла бы над
                серединой прокрутки. */}
            <div
              id="app-scroll"
              // data-app-scroll: по этой метке Sheet находит контейнер, чтобы
              // заморозить прокрутку под открытой формой.
              data-app-scroll
              className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
              style={{ overscrollBehavior: 'contain', marginBottom: 'var(--fab-strip, 0px)' }}
            >
              {/* Баннер установки — первый элемент ЛЕНТЫ, а не каркаса. Стоя над
                  таб-баром, он занимал до 150px и на столько же поднимал
                  плавающую кнопку — та садилась в середину экрана и накрывала
                  всё, до чего доскроллили (замеры: сегмент «Год» в Финансах 66%,
                  карандаш раздела 93%). Уезжая вместе с лентой, он не отнимает
                  места ни у кнопки, ни у контента; при смене маршрута лента и
                  так кидается наверх (ScrollReset), так что баннер виден. */}
              <InstallBanner />
              {/* Обёртка забирает ровно ОСТАТОК высоты после баннера. Без неё
                  экран «во весь рост» (чат) брал h-full от всей ленты, не
                  вычитая баннер, — и поле ввода уезжало за нижний край: с
                  показанным баннером написать сообщение было нельзя вовсе.
                  min-h-0 обязателен: без него обёртка растёт по содержимому
                  ленты, и h-full внутри снова оказывается больше экрана. */}
              <div className="flex min-h-0 flex-1 flex-col">
              <Routes>
                <Route path="/" element={<TodayPage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/share" element={<SharePage />} />
                <Route path="/stats" element={<StatsPage />} />
                <Route path="/calendar" element={<CalendarPage />} />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/more/trash" element={<TrashPage />} />
                <Route path="/notes" element={<NotesPage />} />
                <Route path="/notes/:id" element={<NoteEditorPage />} />
                <Route path="/goals" element={<GoalsPage />} />
                <Route path="/goals/:id" element={<GoalDetailPage />} />
                <Route path="/home" element={<HomePage />} />
                <Route path="/home/profile" element={<ProfilePage />} />
                {/* Старый адрес «Ещё» ведёт на «Главную». Подразделы остаются на
                    /more/*: этот префикс зашит в push-sw.js
                    (/life-hub/more/family), и у всех, кто не обновил service
                    worker, переход по уведомлению сломался бы. Разнородные
                    адреса — цена за несломанные уведомления и закладки. */}
                <Route path="/more" element={<Navigate to="/home" replace />} />
                <Route path="/more/family" element={<FamilyPage />} />
                <Route path="/more/ai" element={<AiPage />} />
                <Route path="/more/focus" element={<FocusPage />} />
                <Route path="/more/learning" element={<LearningPage />} />
                <Route path="/more/finance" element={<FinancePage />} />
                <Route path="/more/energy" element={<EnergyPage />} />
                <Route path="/more/habits" element={<HabitsPage />} />
                <Route path="/more/cycle" element={<RequireFemale><CyclePage /></RequireFemale>} />
                <Route path="/more/cycle/settings" element={<RequireFemale><CycleSettingsPage /></RequireFemale>} />
                <Route path="/more/cycle/year" element={<RequireFemale><CycleYearPage /></RequireFemale>} />
                <Route path="/more/cycle/report" element={<RequireFemale><CycleReportPage /></RequireFemale>} />
                <Route path="/more/places" element={<PlacesPage />} />
                <Route path="/more/settings" element={<SettingsPage />} />
                <Route path="/more/settings/install" element={<InstallInstructionsPage />} />
                <Route path="/more/settings/backup" element={<BackupPage />} />
                <Route path="/more/settings/sections" element={<SectionsSettingsPage />} />
                {/* Неизвестный адрес (битый дип-линк из пуша, старая закладка)
                    рендерил немую пустоту — ни шапки, ни объяснения. Честный
                    экран с выходом лучше молчания. */}
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
              </div>
            </div>
            <ReloadPrompt />
            <MiniTimer />
            <TabBar />
          </div>
          {/* Обязательный выбор пола — первым делом, раньше тура и остальных
              окон: он стоит в DOM ПОСЛЕ них и тем же z-[80] перекрывает всё,
              пока выбор не сделан. Порядок именно такой, а не условный рендер
              соседей: тур и «что нового» должны показаться сразу после выбора,
              не дожидаясь перезагрузки. */}
          {/* Вводный тур для нового пользователя — поверх всего, пока не пройден. */}
          <OnboardingOverlay />
          {/* Одноразовое окно о смене имени/значка — только «старым» пользователям. */}
          <ReinstallNotice />
          {/* Что изменилось в этом обновлении. Обновление ставится тихо, и без
              этого окна человек не узнаёт ни что версия сменилась, ни чем. */}
          <WhatsNew />
          <GenderGate />
        </ErrorBoundary>
        </PomodoroProvider>
      </ToastProvider>
      </LucideProvider>
    </BrowserRouter>
  );
}
