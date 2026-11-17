import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Sheet } from '../../components/ui/Sheet';
import { db } from '../../db/db';
import { updateSettings } from '../../hooks/useSettings';
import { APP_VERSION, RELEASES, compareVersions } from '../../lib/changelog';
import { formatRu } from '../../lib/dates';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import {
  GSparkle as Sparkles,
} from '../../components/ui/glyphs';

/** «Что нового» после обновления.
 *
 *  Обновление в приложении тихое: новый service worker активируется сам, и
 *  страница перезагружается на свежую версию. Это удобно, но человек не узнаёт
 *  ни что что-то изменилось, ни что именно. Отсюда окно: показывается один раз
 *  после смены версии и больше не возвращается.
 *
 *  Не показывается тому, кто открыл приложение впервые: для него всё новое, и
 *  список изменений вместо приветствия — бессмыслица. Первый запуск узнаём по
 *  отсутствию пройденного онбординга. */
export function WhatsNew() {
  // Читаем напрямую, а не через useSettings: тот подставляет значения по
  // умолчанию, пока Dexie не ответил, и «ещё не загрузилось» становится
  // неотличимо от «записи нет». На этом механизм и ломался: на первом рендере
  // виделось lastSeenVersion === undefined, эффект считал это первым запуском
  // и затирал реальную версию — окно не показывалось никогда.
  const settings = useLiveQuery(() => db.settings.get('app'), []);
  const loading = settings === undefined;
  const seen = settings?.lastSeenVersion;
  const onboarded = Boolean(settings?.onboardingDone);

  // Закрыто в этом сеансе — помним вместе с версией, для которой закрывали.
  // Кнопка «Что нового» в настройках сбрасывает lastSeenVersion, и окно обязано
  // открыться снова даже у того, кто уже закрывал его в этом сеансе. Раньше
  // сброс делал эффект со setState: лишний каскад рендеров ради значения,
  // которое вычисляется прямо здесь.
  const [dismissal, setDismissal] = useState<{ seen?: string; value: boolean }>({ value: false });
  // Версия ушла с той, при которой закрывали, — закрытие записалось в базу (или
  // пришёл сброс из настроек), и помнить его больше незачем. Гасим совсем, а не
  // только «не совпадает»: иначе память оживала, когда версия возвращалась к
  // прежнему значению. Кнопка в настройках каждый раз пишет '', и второе
  // нажатие совпадало с первым закрытием — окно считалось закрытым, а '' так и
  // оставалась в базе и выкидывала окно при следующем запуске (прогон 13–17.09).
  if (dismissal.value && dismissal.seen !== seen) setDismissal({ value: false });
  const dismissed = dismissal.seen === seen && dismissal.value;
  const setDismissed = (value: boolean) => setDismissal({ seen, value });
  // Версию молча запоминаем в двух случаях, когда окно показывать не надо:
  //  — первый запуск: человеку всё новое, список изменений вместо приветствия
  //    бессмыслен;
  //  — приложение стояло до появления этого механизма: неизвестно, что человек
  //    уже видел, и показывать ему всю историю как новость неправильно.
  const silentCatchUp = !loading && (!onboarded || seen === undefined);

  useEffect(() => {
    if (silentCatchUp && seen !== APP_VERSION) {
      void updateSettings({ lastSeenVersion: APP_VERSION });
    }
  }, [silentCatchUp, seen]);

  const open = !loading && !silentCatchUp && seen !== APP_VERSION && !dismissed;

  function close() {
    setDismissed(true);
    void updateSettings({ lastSeenVersion: APP_VERSION });
  }

  // Показываем все выпуски новее виденного: человек мог пропустить несколько
  // обновлений подряд, и «что нового» только про последнее его обманет.
  const fresh = RELEASES.filter((r) => (seen ? compareVersions(r.version, seen) > 0 : false));
  const list = fresh.length > 0 ? fresh : RELEASES.slice(0, 1);

  if (!open) return null;

  return (
    <Sheet open onClose={close} title={t('Что нового')}>
      <div className="flex flex-col gap-6 pb-2">
        {list.map((r) => (
          <section key={r.version}>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="inline-flex h-7 items-center rounded-full bg-lh-accent-dim px-3 text-xs font-semibold tabular-nums text-lh-accent">
                {t('Версия')} {r.version}
              </span>
              <span className="text-xs text-lh-text-secondary">{formatRu(r.date, 'd MMMM')}</span>
            </div>
            <ul className="mt-4 space-y-4">
              {r.items.map((it, i) => (
                <li key={i} className="flex items-start gap-4">
                  <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 text-lh-accent">
                    <Sparkles size={ICON.base} />
                  </span>
                  <span className="min-w-0 flex-1 pt-1.5 text-sm leading-[1.45] text-lh-text-primary/90">{it}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <button
          type="button"
          onClick={close}
          className="flex h-[52px] w-full items-center justify-center rounded-xl bg-lh-accent text-base font-semibold text-lh-bg active:opacity-80"
        >
          {t('Понятно')}
        </button>
      </div>
    </Sheet>
  );
}
