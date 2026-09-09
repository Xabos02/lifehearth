import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  LayoutGrid,
  Lightbulb,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import {
  GChevronRight as ChevronRight,
  GTasks as ListTodo,
  GNotes as NotebookText,
  GSparkle as Sparkles,
  GSun as Sun,
  GTarget as Target,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { now } from '../../db/repo';
import { updateSettings } from '../../hooks/useSettings';
import { REINSTALL_NOTICE_VERSION } from '../../lib/appInstall';
import { t } from '../../lib/i18n';
import { ICON, STROKE_STRONG } from '../../components/ui/icons';

const SLIDES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Sparkles,
    title: 'Добро пожаловать в LifeHearth',
    text: 'LifeHearth — тихий центр жизни. Задачи, цели, заметки, деньги и семья — в одном спокойном месте, всегда под рукой и даже без интернета. Всё живёт на устройстве и принадлежит только вам.',
  },
  {
    icon: Sun,
    title: 'Сегодня',
    text: 'День начинается с ясной головы. «Сегодня» мягко показывает только то, что важно сейчас — без давления длинных списков. Один взгляд — и понятно, куда двигаться.',
  },
  {
    icon: ListTodo,
    title: 'Задачи без давления',
    text: 'Задачи — не про «надо», а про свободу не держать всё в голове. Записали и отпустили: приложение напомнит вовремя, и можно жить, а не сверяться со списком.',
  },
  {
    icon: NotebookText,
    title: 'Заметки',
    text: 'Место для мыслей и идей, которые жалко потерять. Просто начните писать — первая строка станет заголовком. Второй мозг, всегда под рукой.',
  },
  {
    icon: Target,
    title: 'Цели',
    text: 'Мечты становятся ближе, когда виден прогресс. Накопить, пробежать, выучить — поставьте цель и смотрите, как она приближается шаг за шагом.',
  },
  {
    icon: LayoutGrid,
    title: 'Настраивается под вас',
    text: 'Остальные грани жизни: семья и общий чат, финансы и накопления, привычки, здоровье, места. Оставьте нужное, спрячьте лишнее — приложение подстраивается под вас, а не наоборот.',
  },
  {
    icon: ShieldCheck,
    title: 'Никто, кроме вас',
    text: 'Данные остаются на устройстве. Включите синхронизацию — они будут на всех ваших устройствах под вашим ключом, а зашифрованная копия переживёт даже потерю телефона. И напоминания придут, даже когда приложение закрыто.',
  },
  {
    icon: Lightbulb,
    title: 'Рядом, когда нужно',
    text: 'Ничего не нужно заучивать. LifeHearth подскажет удобные мелочи тогда, когда пригодятся: жесты, быстрый ввод, даже то, что кнопку «+» можно перетащить куда удобно. А дальше — просто жить, остальное рядом.',
  },
];

/**
 * Вводный тур по разделам для нового пользователя. Показывается поверх всего
 * приложения, пока в настройках не проставлен onboardingDone (кнопки «Начать»
 * или «Пропустить»). Повторный показ — из Настроек («Показать обучение»).
 */
export function OnboardingOverlay() {
  const settings = useLiveQuery(() => db.settings.get('app'), []);
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  // Пока настройки не загрузились — не мигаем туром; пройден — не показываем.
  if (!settings || settings.onboardingDone) return null;

  const finish = () => {
    setStep(0); // повторный запуск из Настроек начнётся с первого слайда
    // reinstallNoticeSeen проставляем сразу текущей версией: тот, кто ставит
    // приложение сейчас, уже получил актуальный значок — окно о переустановке
    // ему не нужно.
    void updateSettings({ onboardingDone: now(), reinstallNoticeSeen: REINSTALL_NOTICE_VERSION });
  };

  /** Человек ставит приложение НЕ с нуля: телефон заменили, данные лежат в
   *  облаке под его ключом. Раньше он проходил восемь слайдов и оказывался на
   *  пустом экране без единой подсказки, откуда возвращать своё, — путь начинался
   *  в настройках, куда ещё надо догадаться зайти. */
  const restore = () => {
    finish();
    navigate('/more/settings');
  };

  const slide = SLIDES[step];
  const Icon = slide.icon;
  const last = step === SLIDES.length - 1;

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-bg">
      <div aria-hidden className="aurora pointer-events-none absolute inset-0" />
      {/* key={step} перезапускает fade-in при смене слайда */}
      <div
        key={step}
        className="relative flex min-h-0 flex-1 animate-fade-in flex-col items-center justify-center gap-5 px-8 text-center"
      >
        <div className="flex size-20 items-center justify-center rounded-3xl tile-accent text-accent shadow-[var(--shadow-accent)]">
          <Icon size={ICON.hero} strokeWidth={STROKE_STRONG} />
        </div>
        <h2 className="text-2xl font-bold tracking-tight">{t(slide.title)}</h2>
        <p className="max-w-sm text-sm leading-relaxed text-muted">{t(slide.text)}</p>
      </div>

      <div className="relative flex items-center justify-center gap-1.5 pb-5">
        {SLIDES.map((_, i) => (
          <button
            key={i}
            type="button"
            aria-label={t('Шаг {n}', { n: i + 1 })}
            onClick={() => setStep(i)}
            className={`h-2 rounded-full transition-all ${
              i === step ? 'w-5 bg-accent' : 'w-2 bg-muted/40'
            }`}
          />
        ))}
      </div>

      <div className="relative flex items-center gap-3 px-6 pb-[calc(env(safe-area-inset-bottom)+20px)]">
        <button
          type="button"
          onClick={finish}
          className="px-3 py-3 text-sm font-medium text-muted active:opacity-60"
        >
          {t('Пропустить')}
        </button>
        <button
          type="button"
          onClick={last ? finish : () => setStep((s) => s + 1)}
          className="flex flex-1 items-center justify-center gap-1 rounded-2xl bg-accent-fill px-5 py-3.5 font-semibold text-white shadow-[var(--shadow-accent)] active:opacity-80"
        >
          {last ? t('Начать') : t('Далее')}
          {!last && <ChevronRight size={ICON.base} />}
        </button>
      </div>

      {/* Развилка для того, кто переезжает, а не начинает: показываем на
          последнем шаге, чтобы не сбивать первое знакомство. */}
      <button
        type="button"
        onClick={restore}
        className={`relative px-6 pb-[calc(env(safe-area-inset-bottom)+16px)] text-sm font-medium text-accent active:opacity-60 ${
          last ? '' : 'invisible'
        }`}
      >
        {t('У меня уже были данные — восстановить')}
      </button>
    </div>
  );
}
