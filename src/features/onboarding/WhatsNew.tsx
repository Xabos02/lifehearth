import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
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
      <div className="flex flex-col gap-4 pb-2">
        {list.map((r) => (
          <section key={r.version}>
            <div className="mb-2 flex items-baseline gap-2">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                <Sparkles size={ICON.inline} />
              </span>
              {/* min-w-0 у левой части: без него дата ужимает версию до буквы. */}
              <span className="min-w-0 flex-1 font-semibold">{t('Версия')} {r.version}</span>
              <span className="shrink-0 text-xs text-muted">{formatRu(r.date, 'd MMMM')}</span>
            </div>
            <ul className="space-y-2">
              {r.items.map((it, i) => (
                <li key={i} className="flex items-start gap-2.5 text-sm leading-snug">
                  <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent/60" />
                  <span className="min-w-0 flex-1 text-text/90">{it}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <Button className="w-full" onClick={close}>
          {t('Понятно')}
        </Button>
      </div>
    </Sheet>
  );
}
