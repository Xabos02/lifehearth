import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ComponentType } from 'react';
import { ArrowRight } from 'lucide-react';
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
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';

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
    // Сразу на экран копий: начало «Настроек» — оформление и уведомления,
    // про восстановление там ни слова, а нужный блок полтора экрана ниже.
    navigate('/more/settings/backup');
  };

  const slide = SLIDES[step];
  const Art = slide.art;
  const last = step === SLIDES.length - 1;

  return (
    <div className="fixed inset-0 z-[80] flex flex-col overflow-y-auto bg-lh-bg">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-6 pt-[env(safe-area-inset-top)]">
        {/* «Пропустить» — на каждом шаге и в одном и том же месте сверху:
            тот, кто хочет выйти, не должен пролистывать до «Начать». */}
        <div className="flex h-12 items-center justify-between">
          <span className="text-sm tabular-nums text-lh-text-secondary">
            {t('Шаг {n} из {total}', { n: step + 1, total: SLIDES.length })}
          </span>
          <button
            type="button"
            onClick={finish}
            className="-mr-3 flex h-11 items-center px-3 text-[15px] text-lh-text-secondary active:opacity-60"
          >
            {t('Пропустить')}
          </button>
        </div>

        {/* key={step} перезапускает fade-in при смене слайда.

            Свайп влево/вправо листает слайды — на телефоне это первый жест,
            который пробуют. touch-action pan-y оставляет вертикальную
            прокрутку браузеру, а горизонталь забираем себе. Порог 48px
            отличает свайп от дрожи пальца. */}
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
          className="flex animate-fade-in flex-col"
        >
          <div className="mt-4 flex h-[clamp(200px,36vh,360px)] items-center justify-center overflow-hidden rounded-[24px] border border-lh-border bg-lh-surface">
            {Art === 'app-icon' ? (
              // Своя иконка, а не плитка: то, что человек только что поставил
              // на «Домой». Тень тёплая — от углей на самой иконке.
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
          </div>
          <h2 className="mt-[clamp(20px,3.5vh,32px)] text-[30px] font-light leading-[1.15] tracking-[-.6px]">{t(slide.title)}</h2>
          <p className="mt-2.5 text-base leading-normal text-lh-text-secondary">{t(slide.text)}</p>
        </div>

        {/* gap-4 + HIT_SLOP_44: невидимые зоны касания соседних точек не
            перекрываются, тап уходит той точке, по которой целились. */}
        <div className="mt-6 flex items-center gap-4 pl-1">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={t('Шаг {n}', { n: i + 1 })}
              aria-current={i === step ? 'step' : undefined}
              onClick={() => setStep(i)}
              className={`h-1.5 rounded-full transition-all ${HIT_SLOP_44} ${
                i === step ? 'w-6 bg-lh-accent' : 'w-1.5 bg-lh-text-tertiary/50'
              }`}
            />
          ))}
        </div>

        <div className="mt-auto pb-[calc(env(safe-area-inset-bottom)+12px)] pt-6">
          <div className="flex gap-3">
            {/* На первом шаге «Назад» нет — возвращаться некуда. */}
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => s - 1)}
                className="h-[52px] rounded-xl border border-lh-border bg-lh-surface px-6 text-base active:opacity-70"
              >
                {t('Назад')}
              </button>
            )}
            <button
              type="button"
              onClick={last ? finish : () => setStep((s) => s + 1)}
              className="flex h-[52px] flex-1 items-center justify-center gap-2 rounded-xl bg-lh-accent text-base font-semibold text-lh-bg active:opacity-80"
            >
              {last ? t('Начать') : t('Далее')}
              {!last && <ArrowRight size={ICON.inline} strokeWidth={2.4} />}
            </button>
          </div>

          {/* Развилка для того, кто переезжает, а не начинает: на первом шаге
              и на последнем. Человек с новым телефоном не хочет смотреть
              семь слайдов, ему надо вернуть свои записи; новичку же вход
              первым экраном — стена. На средних слайдах строка прячется
              (invisible, а не удаляется — кнопки не прыгают). */}
          <button
            type="button"
            onClick={restore}
            className={`mt-3 flex h-11 w-full items-center justify-center text-sm text-lh-accent active:opacity-60 ${
              step === 0 || last ? '' : 'invisible'
            }`}
          >
            {t('У меня уже были данные — восстановить')}
          </button>
        </div>
      </div>
    </div>
  );
}
