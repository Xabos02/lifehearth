import { Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  GChevronRight as ChevronRight,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import { todayKey, formatDayRange } from '../../lib/dates';
import { cycleDayFor } from '../../lib/cycle/derive';
import { predictNextPeriod } from '../../lib/cycle/predict';
import { cycleAllowed } from '../../lib/sections';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

/** Строка раздела на экране «Сегодня».
 *
 *  Выключена по умолчанию и включается в настройках раздела. «Сегодня» — экран,
 *  который чаще прочих видят через плечо, поэтому здесь только номер дня и, если
 *  прогноз включён, диапазон дат. Никаких предсказаний состояния: ни «может быть
 *  мало сил», ни эмодзи, ни советов. Приложение знает день цикла, а не то, как
 *  человек себя чувствует.
 *
 *  Считает сама, а не через useCycleData: тому нужны все дни и симптомы ради
 *  статистики, а здесь хватает циклов и эпизодов — на экране «Сегодня» лишний
 *  запрос ко всей истории ни к чему. */
export function CycleTodayLine() {
  const appSettings = useLiveQuery(() => db.settings.get('app'), []);
  const settings = useLiveQuery(() => db.cycleSettings.get('app'), []);
  const cycles = useLiveQuery(() => db.cycles.orderBy('startDate').toArray(), []);
  const episodes = useLiveQuery(() => db.cycleEpisodes.toArray(), []);

  // Пол сильнее тумблера: тумблер могли включить в женском профиле, а потом
  // пол сменить — строка обязана исчезнуть вместе с разделом.
  //
  // А вот скрытие раздела из навигации строку НЕ глушит намеренно: у цикла
  // «скрыт» — это приватность (раздел не светится в меню, по умолчанию он
  // вообще спрятан), а строка включается отдельным сознательным тумблером за
  // замком раздела. Правило «скрытый раздел молчит» — для блоков без своего
  // выключателя (привычки, энергия), здесь оно ломало бы легитимный сценарий
  // «в меню не показывать, строку показывать».
  if (!cycleAllowed(appSettings?.gender)) return null;
  if (!settings?.integrations.todayCard) return null;
  if (cycles === undefined || episodes === undefined || cycles.length === 0) return null;

  const today = todayKey();
  const day = cycleDayFor(today, cycles, episodes);
  if (day === undefined) return null;

  const prediction = settings.predictionsEnabled
    ? predictNextPeriod({ cycles, episodes, today })
    : null;
  const range =
    prediction?.lo80 !== undefined && prediction.hi80 !== undefined
      ? formatDayRange(prediction.lo80, prediction.hi80)
      : null;

  return (
    <Link to="/more/cycle" className="card mb-5 flex items-center gap-3 p-4 active:opacity-80">
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{t('День цикла {day}', { day })}</span>
        {range && (
          <span className="mt-0.5 block text-sm text-muted">{t('Следующая менструация {range}', { range })}</span>
        )}
      </span>
      <ChevronRight size={ICON.base} className="shrink-0 text-muted" />
    </Link>
  );
}
