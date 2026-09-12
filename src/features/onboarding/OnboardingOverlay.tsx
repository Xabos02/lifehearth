import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ComponentType } from 'react';
import {
  GChevronLeft as ChevronLeft,
  GChevronRight as ChevronRight,
} from '../../components/ui/glyphs';
import {
  DataIllo,
  FamilyIllo,
  GoalsIllo,
  NotesIllo,
  SimpleIllo,
  TasksIllo,
  TodayIllo,
} from './illustrations';
import { db } from '../../db/db';
import { now } from '../../db/repo';
import { updateSettings } from '../../hooks/useSettings';
import { REINSTALL_NOTICE_VERSION } from '../../lib/appInstall';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

// Тексты слайдов — 11-16 слов каждый, одна мысль на слайд.
//
// До 11.09.2026 на слайде стояло 35-45 слов: «тихий центр жизни», «второй
// мозг», «мечты становятся ближе». Владелец: «текст неравномерно распределён,
// нанесён абы как, всё сливается, трудно понять, что происходит». Для
// человека, который видит приложение впервые, это стена. Теперь заголовок
// говорит, ЧТО это, текст — что с этим делать; у семьи свой слайд, как
// просил владелец.
// Картинки — задача 13 (пункты 2, 5, 6): на первом слайде иконка приложения
// крупно, дальше рисованные иллюстрации в одном стиле (illustrations.tsx).
// Плитка с иконкой раздела, которая стояла тут раньше, была служебной, а не
// картинкой: 80px на весь экран, и одна и та же на всех восьми слайдах.
const SLIDES: { art: ComponentType | 'app-icon'; title: string; text: string }[] = [
  {
    art: 'app-icon',
    title: 'Всё в одном месте',
    text: 'Задачи, заметки, цели, деньги и семья. Работает без интернета, всё хранится у вас на телефоне.',
  },
  {
    art: TodayIllo,
    title: 'Сегодня',
    text: 'Один экран на день: что сделать, что запланировано, как вы себя чувствуете. Ничего лишнего.',
  },
  {
    art: TasksIllo,
    title: 'Задачи',
    text: 'Запишите и отпустите. Приложение напомнит вовремя — заранее или утром в день задачи.',
  },
  {
    art: NotesIllo,
    title: 'Заметки',
    text: 'Начните писать — первая строка станет названием. Фото и файлы прикрепляются прямо в заметку.',
  },
  {
    art: GoalsIllo,
    title: 'Цели',
    text: 'Поставьте цель и отмечайте шаги. Прогресс виден сразу — и по деньгам, и по делам.',
  },
  {
    art: FamilyIllo,
    title: 'Семья',
    text: 'Общий чат, звонки и задачи на всех. Переписка зашифрована — её видят только участники.',
  },
  {
    art: DataIllo,
    title: 'Ваши данные',
    text: 'Всё хранится на телефоне. Включите синхронизацию — записи появятся на всех устройствах и переживут потерю телефона.',
  },
  {
    art: SimpleIllo,
    title: 'Дальше — просто',
    text: 'Подсказки появятся сами, когда пригодятся. Ненужные разделы можно спрятать в настройках.',
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
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
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
  const Art = slide.art;
  const last = step === SLIDES.length - 1;

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-bg">
      <div aria-hidden className="aurora pointer-events-none absolute inset-0" />
      {/* key={step} перезапускает fade-in при смене слайда.

          Свайп влево/вправо листает слайды — на телефоне это первый жест,
          который пробуют, и до 11.09.2026 он не делал ничего. touch-action
          pan-y оставляет вертикальную прокрутку браузеру, а горизонталь
          забираем себе. Порог 48px отличает свайп от дрожи пальца. */}
      <div
        key={step}
        onPointerDown={(e) => {
          swipeStart.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const from = swipeStart.current;
          swipeStart.current = null;
          if (!from) return;
          const dx = e.clientX - from.x;
          const dy = e.clientY - from.y;
          if (Math.abs(dx) < 48 || Math.abs(dy) > Math.abs(dx)) return;
          if (dx < 0 && !last) setStep((s) => s + 1);
          if (dx > 0 && step > 0) setStep((s) => s - 1);
        }}
        style={{ touchAction: 'pan-y' }}
        className="relative flex min-h-0 flex-1 animate-fade-in flex-col items-center justify-center gap-5 px-8 text-center"
      >
        {Art === 'app-icon' ? (
          // Своя иконка, а не плитка: то, что человек только что поставил на
          // «Домой». Тень тёплая — от углей на самой иконке.
          <img
            src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
            alt=""
            width={160}
            height={160}
            className="onb-app-icon"
          />
        ) : (
          <Art />
        )}
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
        {/* На первом шаге слева «Пропустить», дальше — «Назад»: вернуться к
            предыдущему слайду было нельзя вовсе, только точками внизу, а их
            как кнопки никто не читает. «Пропустить» на остальных шагах не
            теряется: тот, кто хочет выйти, жмёт «Далее» до «Начать». */}
        {step === 0 ? (
          <button
            type="button"
            onClick={finish}
            className="px-3 py-3 text-sm font-medium text-muted active:opacity-60"
          >
            {t('Пропустить')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setStep((s) => s - 1)}
            aria-label={t('Назад')}
            className="flex items-center gap-1 px-3 py-3 text-sm font-medium text-muted active:opacity-60"
          >
            <ChevronLeft size={ICON.base} />
            {t('Назад')}
          </button>
        )}
        <button
          type="button"
          onClick={last ? finish : () => setStep((s) => s + 1)}
          className="flex flex-1 items-center justify-center gap-1 rounded-2xl bg-accent-fill px-5 py-3.5 font-semibold text-white shadow-[var(--shadow-accent)] active:opacity-80"
        >
          {last ? t('Начать') : t('Далее')}
          {!last && <ChevronRight size={ICON.base} />}
        </button>
      </div>

      {/* Развилка для того, кто переезжает, а не начинает.

          На ПЕРВОМ шаге и на последнем. Владелец просил вход до обучения:
          человек с новым телефоном не хочет смотреть семь слайдов, ему надо
          вернуть свои записи. Но для новичка вход первым экраном — стена до
          того, как он понял, зачем приложение. Поэтому развилка, а не
          порядок: на первом экране оба пути видны, на средних слайдах строка
          прячется, чтобы не сбивать знакомство, на последнем возвращается. */}
      <button
        type="button"
        onClick={restore}
        className={`relative px-6 pb-[calc(env(safe-area-inset-bottom)+16px)] text-sm font-medium text-accent active:opacity-60 ${
          step === 0 || last ? '' : 'invisible'
        }`}
      >
        {t('У меня уже были данные — восстановить')}
      </button>
    </div>
  );
}
