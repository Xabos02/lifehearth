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
        t('Вопрос — и прочитанные записи, если включены «Данные», — через наш сервер к Polza.ai и модели Claude компании Anthropic (США).') +
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
      className="fixed inset-0 z-[84] flex flex-col bg-bg"
    >
      <div aria-hidden className="aurora pointer-events-none absolute inset-0" />
      {/* key: смена вида — новый контейнер прокрутки, с начала, а не с того
          места, куда пролистали краткий вид. */}
      <div
        key={details ? 'details' : 'short'}
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-[calc(env(safe-area-inset-top)+16px)] pb-4"
      >
        {details ? (
          <>
            <button
              type="button"
              onClick={() => setDetails(false)}
              className="-ml-1 flex min-h-11 items-center gap-0.5 self-start pr-1 text-accent active:opacity-60"
            >
              <GChevronLeft size={ICON.accent} strokeWidth={STROKE_STRONG} />
              {t('Коротко')}
            </button>
            <h2 id="consent-title" ref={titleRef} tabIndex={-1} className="mt-2 text-lg font-bold tracking-tight outline-none">
              {t('Что уходит с телефона')}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {t('Всё, что вы записываете, хранится на этом телефоне и работает без интернета. Часть функций выходит в сеть. Согласие одно — на всё сразу.')}
            </p>
            <Group
              icon={<GLock size={ICON.header} className="text-accent" />}
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
            <p className="mt-5 text-xs leading-relaxed text-muted">
              <span className="font-semibold text-text">{t('И без согласия.')}</span>{' '}
              {t('Приложение загружается и обновляется с GitHub Pages — GitHub видит IP-адрес и время. Ссылки и «Открыть на карте» открывают чужие сайты, только когда вы нажмёте; картам Apple уходит адрес места.')}
            </p>
          </>
        ) : (
          <>
            <div className="mt-6 mb-6 flex flex-col items-center gap-3 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl tile-accent text-accent">
                {reason ? REASON_ICON[reason] : <GPhoneOut size={ICON.accent} />}
              </div>
              <h2 id="consent-title" ref={titleRef} tabIndex={-1} className="text-lg font-bold tracking-tight outline-none">
                {reason && !review ? t(REASON_TITLES[reason]) : t('Что уходит с телефона')}
              </h2>
              {reason && !review && (
                <p className="text-sm leading-relaxed text-muted">
                  {t('Согласие одно — на всё внешнее сразу: семья, ассистент и остальное второй раз этого окна не покажут.')}
                </p>
              )}
            </div>
            {pausing && (
              <div className="mb-5 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3.5">
                <p className="text-sm font-semibold">{t('Сейчас у вас включено')}</p>
                <div className="my-2 flex flex-wrap gap-1.5">
                  {on.map((k) => (
                    <span key={k} className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold">
                      {t(EXTERNAL_LABELS[k])}
                    </span>
                  ))}
                </div>
                <p className="text-xs leading-relaxed">
                  {t('Без согласия это встанет на паузу: телефон ничего не отправит, а сервер продолжит присылать уведомления — напоминания, сообщения и звонки семьи. Ничего не удалится — «Принимаю» вернёт как было.')}
                </p>
              </div>
            )}
            <ul className="flex flex-col gap-4">
              <Point icon={<Smartphone size={ICON.header} strokeWidth={STROKE_STRONG} className="text-success" />}>
                <span className="font-semibold">{t('Записи хранятся на телефоне')}</span>{' '}
                <span className="text-muted">{t('и работают без интернета — задачи, заметки, цели, деньги, здоровье.')}</span>
              </Point>
              <Point icon={<GLock size={ICON.header} className="text-accent" />}>
                <span className="font-semibold">{t('Синхронизация, напоминания и семья')}</span>{' '}
                <span className="text-muted">
                  {t('передают записи на наш сервер зашифрованными. Сервер видит служебное: когда, из какого раздела, кто в сети, название семейной группы и ваш IP-адрес. При звонке IP-адрес виден ещё серверам связи и собеседнику.')}
                </span>
              </Point>
              <Point icon={<Eye size={ICON.header} strokeWidth={STROKE_STRONG} className="text-warning" />}>
                <span className="font-semibold">{t('Ассистент, голосовой ввод и погода')}</span>{' '}
                <span className="text-muted">
                  {t('передают то, что вы им даёте, открытым текстом — нашему серверу и сторонним службам: Polza.ai, Anthropic, Google, Apple, Microsoft, Open-Meteo.')}
                </span>
              </Point>
            </ul>
            <button
              type="button"
              onClick={() => setDetails(true)}
              className="mt-5 flex min-h-12 w-full items-center justify-between gap-2 card px-4 text-left text-sm font-semibold active:bg-surface-2"
            >
              {t('Подробно, по каждой функции')}
              <GChevronRight size={ICON.header} className="shrink-0 text-muted" />
            </button>
          </>
        )}
      </div>

      <div className="relative flex flex-col gap-1 px-6 pt-3 pb-[calc(env(safe-area-inset-bottom)+16px)]">
        {review ? (
          <button
            type="button"
            onClick={() => {
              setDetails(false);
              closeConsent();
            }}
            className="flex w-full items-center justify-center rounded-2xl bg-accent-fill px-5 py-3.5 font-semibold text-white shadow-[var(--shadow-accent)] active:opacity-80"
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
              className="flex w-full items-center justify-center rounded-2xl bg-accent-fill px-5 py-3.5 font-semibold text-white shadow-[var(--shadow-accent)] active:opacity-80"
            >
              {t('Принимаю')}
            </button>
            <button
              type="button"
              onClick={() => done(false)}
              className="flex min-h-11 w-full items-center justify-center text-sm font-medium text-accent active:opacity-60"
            >
              {pausing ? t('Не принимать — поставить на паузу') : t('Не сейчас')}
            </button>
            {!pausing && (
              <p className="text-center text-xs leading-snug text-muted">
                {t('Без согласия работает всё, что на телефоне, кроме семьи. Перечитать: Настройки → Что уходит с телефона')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Point({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <p className="min-w-0 text-sm leading-relaxed">{children}</p>
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
    <section className="mt-5">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="shrink-0">{icon}</span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold">{title}</h3>
          <p className="text-xs text-muted">{subtitle}</p>
        </div>
      </div>
      <div className="card">
        {rows.map((r) => (
          <div key={r.id} data-channel={r.id} className="border-t border-hairline px-4 py-3 first:border-t-0">
            <p className="text-sm font-semibold">{r.title}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">{r.text}</p>
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
      <div className="relative flex size-20 items-center justify-center rounded-3xl tile-accent text-accent">
        <GFamily size={ICON.hero} />
        <span className="absolute -right-1.5 -bottom-1.5 flex size-7 items-center justify-center rounded-full border-2 border-bg bg-surface-2 text-warning">
          <GPause size={ICON.inline} strokeWidth={STROKE_STRONG} />
        </span>
      </div>
      <h2 className="mt-2 text-lg font-bold tracking-tight">{title}</h2>
      <p className="max-w-sm text-sm leading-relaxed text-muted">{text}</p>
      <button
        type="button"
        onClick={() => void askConsent(reason)}
        className="mt-2 flex items-center justify-center rounded-2xl bg-accent-fill px-6 py-3.5 font-semibold text-white shadow-[var(--shadow-accent)] active:opacity-80"
      >
        {t('Прочитать и принять')}
      </button>
    </div>
  );
}
