import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Eye, Mic, Smartphone } from 'lucide-react';
import { db } from '../../db/db';
import {
  answerConsent,
  askConsent,
  closeConsent,
  useConsent,
  useConsentRequest,
  type ConsentChannel,
  type ConsentReason,
} from '../../lib/consent';
import { cycleAllowed } from '../../lib/sections';
import { t } from '../../lib/i18n';
import { EXTERNAL_LABELS, useExternalOn } from '../../hooks/useExternalOn';
import { ICON, STROKE_STRONG } from '../../components/ui/icons';
import {
  GBellRing,
  GBot,
  GChevronLeft,
  GChevronRight,
  GCloud,
  GFamily,
  GLock,
  GPause,
  GPhoneOut,
} from '../../components/ui/glyphs';

/** Заголовок окна, открытого попыткой включить внешнее (артборд «Попытка
 *  включить»): человек видит, почему окно появилось посреди его действия. */
const REASON_TITLES: Record<ConsentReason, string> = {
  sync: 'Синхронизации нужно согласие',
  backup: 'Облачной копии нужно согласие',
  push: 'Уведомлениям нужно согласие',
  family: 'Семье нужно согласие',
  ai: 'Ассистенту нужно согласие',
  voice: 'Голосовому вводу нужно согласие',
};

const REASON_ICON: Record<ConsentReason, ReactNode> = {
  sync: <GCloud size={ICON.accent} />,
  backup: <GCloud size={ICON.accent} />,
  push: <GBellRing size={ICON.accent} />,
  family: <GFamily size={ICON.accent} />,
  ai: <GBot size={ICON.accent} />,
  voice: <Mic size={ICON.accent} />,
};

/** Подробный список — по каналу на строку (артборд Б, «Подробно»).
 *
 *  Record по ConsentChannel: новый канал в lib/consent.ts без строки здесь не
 *  соберётся — текст окна не может отстать от перечня того, что уходит. */
function channelRows(female: boolean): Record<ConsentChannel, { title: string; text: string }> {
  return {
    sync: {
      title: t('Синхронизация и облачная копия'),
      text: t('Наш сервер хранит шифротекст и видит, из какого раздела запись и когда её меняли.'),
    },
    push: {
      title: t('Напоминания'),
      text: t('Сервер хранит время, зашифрованный текст и адрес доставки. Доставляет служба уведомлений браузера — на iPhone это Apple, в Chrome — Google; текст ей тоже не виден.'),
    },
    family: {
      title: t('Семья'),
      text: t('Сообщения, фото, голосовые, файлы и общие задачи зашифрованы. Серверу видны название группы, кто и когда писал, кто в сети.'),
    },
    ai: {
      title: t('Ассистент'),
      // «Женские дни» — только в женском профиле: у раздела, которого у
      // человека нет, не остаётся и следа (PROTOCOL §7.2).
      text:
        t('Вопрос — и прочитанные записи, если включены «Данные», — через наш сервер к модели на серверах Cloudflare (США). Cloudflare их не хранит и не учит на них модели.') +
        (female ? ' ' + t('«Женские дни» ассистенту недоступны.') : ''),
    },
    calls: {
      title: t('Звонки в семье'),
      text: t('Разговор шифруется. Соединение идёт напрямую или через серверы связи Cloudflare и Metered, запасной — Google: им и собеседнику виден ваш IP-адрес.'),
    },
    voice: {
      title: t('Голосовой ввод'),
      text: t('Речь распознаёт браузер: в Chrome — Google, в Edge — Microsoft, в Safari на маке — Apple. На iPhone приложение голос не слушает.'),
    },
    weather: {
      title: t('Погода'),
      text: t('Open-Meteo получает место с точностью около 11 км и ваш IP-адрес.'),
    },
  };
}

const ENCRYPTED: ConsentChannel[] = ['sync', 'push', 'family'];
const VISIBLE: ConsentChannel[] = ['ai', 'calls', 'voice', 'weather'];

/** Окно «Что уходит с телефона» (задача 34, вариант В выбран Владом 25.09).
 *
 *  Одно согласие на всё внешнее. Показывается само один раз — после
 *  онбординга и расстановки разделов у нового человека, при первом запуске
 *  после обновления у остальных; дальше — по попытке включить внешнее
 *  (askConsent) и из настроек (showConsent).
 *
 *  Во весь экран, а не шитом: шит закрывается свайпом и тапом мимо, а здесь
 *  случайный жест равнялся бы ответу «нет». У того, у кого что-то внешнее
 *  уже включено, «Не сейчас» нет вовсе — две явные кнопки (решение 25.09):
 *  отказ ставит синк, семью и уведомления на паузу, и сделать это надо
 *  сознательно, а не смахнуть окно. */
export function ConsentGate() {
  const settings = useLiveQuery(() => db.settings.get('app'), []);
  const request = useConsentRequest();
  const consent = useConsent();
  const on = useExternalOn(settings);
  const [details, setDetails] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Фокус — в окно: иначе он остаётся в поле под ним (ассистент на маке), и
  // Enter снова жал бы «Отправить»; читалка экрана начинает с заголовка.
  // Смена вида (коротко ⇄ подробно) — тоже сюда.
  const shown = Boolean(request) || (!!settings && !settings.consentAt && !settings.consentAskedAt && !consent);
  const ready = shown && on !== undefined; // окно рисуется, когда список включённого прочитан
  useEffect(() => {
    if (ready) titleRef.current?.focus();
  }, [ready, details]);

  const auto =
    !!settings &&
    !!settings.gender &&
    !!settings.onboardingDone &&
    !!settings.sectionsPriorityDone &&
    !settings.consentAt &&
    !settings.consentAskedAt &&
    !consent;
  if ((!request && !auto) || on === undefined) return null;

  const reason = request?.reason ?? null;
  const review = consent; // перечитать из настроек: ответ уже дан
  // Само открывшееся окно у того, у кого внешнее уже работает: отказ поставит
  // его на паузу — говорим это прямо и не даём смахнуть «Не сейчас».
  const pausing = auto && !request && on.length > 0;
  const rows = channelRows(cycleAllowed(settings?.gender));

  const done = (ok: boolean) => {
    setDetails(false);
    void answerConsent(ok);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-title"
      className="fixed inset-0 z-[84] flex flex-col bg-lh-bg"
    >
      {/* key: смена вида — новый контейнер прокрутки, с начала, а не с того
          места, куда пролистали краткий вид. */}
      <div
        key={details ? 'details' : 'short'}
        className="relative mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col overflow-y-auto px-4 pt-[calc(env(safe-area-inset-top)+16px)] pb-6"
      >
        {details ? (
          <>
            <button
              type="button"
              onClick={() => setDetails(false)}
              className="flex min-h-11 items-center gap-0.5 self-start pr-1 text-base text-lh-accent active:opacity-60"
            >
              <GChevronLeft size={ICON.accent} strokeWidth={STROKE_STRONG} />
              {t('Коротко')}
            </button>
            <h2 id="consent-title" ref={titleRef} tabIndex={-1} className="mt-2 px-2 text-[30px] font-light leading-[1.15] tracking-[-.6px] outline-none">
              {t('Что уходит с телефона')}
            </h2>
            <p className="mt-2.5 px-2 text-sm leading-normal text-lh-text-secondary">
              {t('Всё, что вы записываете, хранится на этом телефоне и работает без интернета. Часть функций выходит в сеть. Согласие одно — на всё сразу.')}
            </p>
            <Group
              icon={<GLock size={ICON.header} className="text-lh-accent" />}
              title={t('Уходит зашифрованным')}
              subtitle={t('Ключ шифрования остаётся на ваших устройствах')}
              rows={ENCRYPTED.map((id) => ({ id, ...rows[id] }))}
            />
            <Group
              icon={<Eye size={ICON.header} strokeWidth={STROKE_STRONG} className="text-warning" />}
              title={t('Видно другим')}
              subtitle={t('Открытый текст или ваш IP-адрес')}
              rows={VISIBLE.map((id) => ({ id, ...rows[id] }))}
            />
            <p className="mt-5 px-2 text-xs leading-relaxed text-lh-text-secondary">
              <span className="font-semibold text-lh-text-primary">{t('И без согласия.')}</span>{' '}
              {t('Приложение загружается и обновляется с GitHub Pages — GitHub видит IP-адрес и время. Ссылки и «Открыть на карте» открывают чужие сайты, только когда вы нажмёте; картам Apple уходит адрес места.')}
            </p>
          </>
        ) : (
          <>
            <div className="px-2 pb-5 pt-2">
              <div className="flex size-14 items-center justify-center rounded-2xl border border-lh-border bg-lh-surface text-lh-accent">
                {reason ? REASON_ICON[reason] : <GPhoneOut size={ICON.accent} />}
              </div>
              <h2
                id="consent-title"
                ref={titleRef}
                tabIndex={-1}
                className="mt-5 text-[30px] font-light leading-[1.15] tracking-[-.6px] outline-none"
              >
                {reason && !review ? t(REASON_TITLES[reason]) : t('Что уходит с телефона')}
              </h2>
              {reason && !review && (
                <p className="mt-2.5 text-sm leading-normal text-lh-text-secondary">
                  {t('Согласие одно — на всё внешнее сразу: семья, ассистент и остальное второй раз этого окна не покажут.')}
                </p>
              )}
            </div>
            {pausing && (
              <div className="mb-6 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3.5">
                <p className="text-sm font-semibold">{t('Сейчас у вас включено')}</p>
                <div className="my-2 flex flex-wrap gap-1.5">
                  {on.map((k) => (
                    <span key={k} className="rounded-full bg-lh-surface-2 px-2.5 py-1 text-xs font-semibold">
                      {t(EXTERNAL_LABELS[k])}
                    </span>
                  ))}
                </div>
                <p className="text-xs leading-relaxed">
                  {t('Без согласия это встанет на паузу: телефон ничего не отправит, а сервер продолжит присылать уведомления — напоминания, сообщения и звонки семьи. Ничего не удалится — «Принимаю» вернёт как было.')}
                </p>
              </div>
            )}
            <section>
              <h3 className="mb-2.5 px-2 lh-section">{t('Коротко')}</h3>
              <ul className="card divide-y divide-lh-border">
                <Point
                  tone="text-success"
                  icon={<Smartphone size={ICON.base} strokeWidth={STROKE_STRONG} />}
                  title={t('Записи хранятся на телефоне')}
                  text={t('и работают без интернета — задачи, заметки, цели, деньги, здоровье.')}
                />
                <Point
                  tone="text-lh-accent"
                  icon={<GLock size={ICON.base} />}
                  title={t('Синхронизация, напоминания и семья')}
                  text={t('передают записи на наш сервер зашифрованными. Сервер видит служебное: когда, из какого раздела, кто в сети, название семейной группы и ваш IP-адрес. При звонке IP-адрес виден ещё серверам связи и собеседнику.')}
                />
                <Point
                  tone="text-warning"
                  icon={<Eye size={ICON.base} strokeWidth={STROKE_STRONG} />}
                  title={t('Ассистент, голосовой ввод и погода')}
                  text={t('передают то, что вы им даёте, открытым текстом — нашему серверу и сторонним службам: Cloudflare, Google, Apple, Microsoft, Open-Meteo.')}
                />
              </ul>
            </section>
            <button
              type="button"
              onClick={() => setDetails(true)}
              className="mt-6 flex min-h-[52px] w-full items-center justify-between gap-2 card px-4 text-left text-sm active:bg-lh-surface-2"
            >
              {t('Подробно, по каждой функции')}
              <GChevronRight size={ICON.inline} className="shrink-0 text-lh-text-secondary" />
            </button>
          </>
        )}
      </div>

      <div className="relative mx-auto flex w-full max-w-md flex-col gap-1 border-t border-lh-border px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+20px)]">
        {review ? (
          <button
            type="button"
            onClick={() => {
              setDetails(false);
              closeConsent();
            }}
            className="flex h-[52px] w-full items-center justify-center rounded-xl bg-lh-accent text-base font-semibold text-lh-bg active:opacity-80"
          >
            {t('Понятно')}
          </button>
        ) : (
          <>
            {/* «Принимаю» — от первого лица, а не глагол в инфинитиве (§7.6):
                формулировка Влада из задачи 34, согласие так и дают. */}
            <button
              type="button"
              onClick={() => done(true)}
              className="flex h-[52px] w-full items-center justify-center rounded-xl bg-lh-accent text-base font-semibold text-lh-bg active:opacity-80"
            >
              {t('Принимаю')}
            </button>
            <button
              type="button"
              onClick={() => done(false)}
              className="flex min-h-11 w-full items-center justify-center text-sm text-lh-text-secondary active:opacity-60"
            >
              {pausing ? t('Не принимать — поставить на паузу') : t('Не сейчас')}
            </button>
            {!pausing && (
              <p className="text-center text-xs leading-snug text-lh-text-secondary">
                {t('Без согласия работает всё, что на телефоне, кроме семьи. Перечитать: Настройки → Что уходит с телефона')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Point({ icon, tone, title, text }: { icon: ReactNode; tone: string; title: string; text: string }) {
  return (
    <li className="flex gap-3.5 p-4">
      <span aria-hidden className={`flex size-9 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 ${tone}`}>
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-xs leading-[1.45] text-lh-text-secondary">{text}</p>
      </div>
    </li>
  );
}

function Group({
  icon,
  title,
  subtitle,
  rows,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  rows: { id: ConsentChannel; title: string; text: string }[];
}) {
  return (
    <section className="mt-6">
      <div className="mb-2.5 flex items-center gap-2 px-2">
        <span className="shrink-0">{icon}</span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold">{title}</h3>
          <p className="text-xs text-lh-text-secondary">{subtitle}</p>
        </div>
      </div>
      <div className="card">
        {rows.map((r) => (
          <div key={r.id} data-channel={r.id} className="border-t border-lh-border px-4 py-3.5 first:border-t-0">
            <p className="text-sm">{r.title}</p>
            <p className="mt-1 text-xs leading-[1.45] text-lh-text-secondary">{r.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Раздел, который без согласия стоит на паузе целиком (артборд «Семья на
 *  паузе»). Одна кнопка — то же окно; «Принимаю» возвращает раздел сразу. */
export function ConsentPause({ reason, title, text }: { reason: ConsentReason; title: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 pt-14 pb-8 text-center">
      <div className="relative flex size-20 items-center justify-center rounded-3xl tile-lh text-lh-accent">
        <GFamily size={ICON.hero} />
        <span className="absolute -right-1.5 -bottom-1.5 flex size-7 items-center justify-center rounded-full border-2 border-bg bg-lh-surface-2 text-warning">
          <GPause size={ICON.inline} strokeWidth={STROKE_STRONG} />
        </span>
      </div>
      <h2 className="mt-2 text-lg font-light tracking-tight">{title}</h2>
      <p className="max-w-sm text-sm leading-relaxed text-lh-text-secondary">{text}</p>
      <button
        type="button"
        onClick={() => void askConsent(reason)}
        className="mt-2 flex items-center justify-center rounded-2xl bg-lh-accent px-6 py-3.5 font-semibold text-lh-bg shadow-[var(--shadow-accent)] active:opacity-80"
      >
        {t('Прочитать и принять')}
      </button>
    </div>
  );
}
