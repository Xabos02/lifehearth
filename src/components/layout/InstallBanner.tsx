import { useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import { Share } from 'lucide-react';
import {
  GClose as X,
} from '../../components/ui/glyphs';
import { dismissInstallBanner, useInstallBannerVisible } from '../../hooks/useInstallBanner';
import { t } from '../../lib/i18n';
import { fillScreenOpen, subscribeFillScreen } from '../../lib/ui/fillScreen';
import { HIT_SLOP_44 } from '../ui/Checkbox';
import { ICON } from '../../components/ui/icons';

/**
 * iOS не поддерживает beforeinstallprompt — показываем баннер с инструкцией,
 * пока приложение открыто во вкладке Safari, а не с экрана «Домой».
 * Логика видимости — в useInstallBanner.
 *
 * Баннер — ПЕРВЫЙ ЭЛЕМЕНТ ЛЕНТЫ (App.tsx, внутри #app-scroll), а не каркаса,
 * и уезжает вместе с прокруткой. Две прежние попытки не сработали: висел
 * поверх на фиксированном отступе — накрывал последний блок, когда текст
 * переносился в три строки; стоял отдельным блоком над таб-баром — занимал до
 * 150px и на столько же поднимал плавающую кнопку, а та садилась в середину
 * экрана и перехватывала тапы по всему, до чего доскроллили (сегмент «Год» в
 * Финансах 66%, карандаш раздела 93%). В ленте он не отнимает места ни у
 * кнопки, ни у контента и не требует, чтобы кто-то знал его высоту.
 */
export function InstallBanner() {
  const visible = useInstallBannerVisible();
  // На экранах во весь рост (чаты) баннеру уезжать некуда — он отнимал бы у
  // переписки шестую часть экрана. Там он молчит и ждёт другого раздела.
  const fillOpen = useSyncExternalStore(subscribeFillScreen, fillScreenOpen, fillScreenOpen);

  if (!visible || fillOpen) return null;

  return (
    <div
      // Одна строка вместо трёх. Прежний вид занимал 106px из 659 на КАЖДОМ
      // экране приложения — самую дорогую площадь верха отдавали системной
      // просьбе, одинаковой во всех разделах. Объяснение, почему это важно,
      // никуда не делось: оно на странице, которая открывается по нажатию.
      className="card print-hide mx-auto mt-3 flex w-[calc(100%-32px)] max-w-lg shrink-0 items-center gap-2.5 px-3 py-2"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg tile-accent text-accent">
        <Share size={ICON.action} />
      </span>
      {/* min-h-11: свернув баннер в строку, ссылку легко оставить ниже нормы —
          зона нажатия обязана держать 44px независимо от высоты текста. */}
      <Link
        to="/more/settings/install"
        className="flex min-h-11 min-w-0 flex-1 items-center truncate text-sm font-medium"
      >
        {t('Установите на экран «Домой»')}
      </Link>
      <button
        aria-label={t('Скрыть')}
        // Хит-зона 44px выступает на 8.75px в стороны — меньше и p-3 карточки
        // (12.75px, значит overflow:hidden у .card её не срежет), и зазора
        // gap-3 до ссылки слева, так что промах не уводит на страницу установки.
        className={`shrink-0 p-1 text-muted ${HIT_SLOP_44}`}
        onClick={dismissInstallBanner}
      >
        <X size={ICON.base} />
      </button>
    </div>
  );
}
