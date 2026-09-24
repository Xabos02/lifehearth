import { useMemo, useSyncExternalStore } from 'react';
import { Screen } from '../../components/layout/Screen';
import { formatRu } from '../../lib/dates';
import { t, tPlur } from '../../lib/i18n';
import { buildYearOverview, type YearDayCell } from '../../lib/cycle/yearView';
import { useCycleData } from './useCycleData';
import { CycleLock } from './CycleLock';
import { isUnlocked, subscribeLock } from './lockState';

/** Годовой обзор: 12 месяцев ретроспективы одним экраном.
 *
 *  Карточка «сейчас» на главном экране раздела намеренно усредняет — иначе
 *  прогноз некому было бы показать. Но у нерегулярного цикла среднее как раз
 *  и есть проблема: оно одно и то же что при разбросе 26–34, что при ровных
 *  29–30, хотя это очень разный опыт. Здесь усреднения нет — только то, что
 *  было по датам, месяц за месяцем, чтобы разброс стало видно глазами, а не
 *  верить одной цифре. Подтверждённый запрос: issue #786 у drip, где годами
 *  просят именно такую сетку вместо помесячного календаря. */
export function CycleYearPage() {
  const data = useCycleData();
  const { settings } = data;

  const open = useSyncExternalStore(subscribeLock, isUnlocked, () => false);
  const locked = settings.lock === 'pin' && settings.pin !== undefined && !open;

  // useMemo здесь не ради экономии (12×31 клеток — копейки), а чтобы объект
  // не пересоздавался при каждом ререндере замка/шапки без причины.
  const view = useMemo(
    () => buildYearOverview(data.dayByDate, data.cycles, data.today),
    [data.dayByDate, data.cycles, data.today],
  );

  return (
    <Screen title={t('Год')} backTo="/more/cycle">
      {locked ? (
        <CycleLock settings={settings} onUnlock={() => undefined} />
      ) : (
        <div className="space-y-5">
          <div className="card p-4">
            <div className="space-y-4">
              {view.months.map((month) => (
                <div key={month.key}>
                  <p className="mb-1 px-0.5 text-xs font-medium text-muted">{month.label}</p>
                  <div className="flex gap-px">
                    {month.days.map((cell) => (
                      <DayCell key={cell.day} cell={cell} />
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Обозначения обязательны рядом с сеткой: без них форма клетки
                («заливка снизу» против «кольцо точки») ничего не сообщает
                тому, кто открыл экран впервые. */}
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-muted">
              <span className="flex items-center gap-1">
                <span className="h-3 w-1.5 rounded-[2px] bg-danger" /> {t('менструация')}
              </span>
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full border border-danger" /> {t('мазня')}
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2.5 rounded-[2px] ring-1 ring-inset ring-accent" />{' '}
                {t('начало цикла')}
              </span>
            </div>
          </div>

          <section>
            <h2 className="mb-1.5 px-1 text-sm font-semibold text-muted">{t('Циклы за период')}</h2>
            {view.cycles.length === 0 ? (
              <p className="px-1 text-sm text-muted">
                {t('За эти 12 месяцев ещё нет ни одного завершённого цикла.')}
              </p>
            ) : (
              <div className="card divide-y divide-hairline px-4">
                {view.cycles.map((c) => (
                  <div key={c.startDate} className="py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-medium">{formatRu(c.startDate)}</span>
                      <span className="shrink-0 text-sm tabular-nums text-muted">
                        {tPlur(c.lengthDays, ['день', 'дня', 'дней'])}
                        {c.periodLengthDays !== undefined &&
                          t(', менструация {n}', { n: tPlur(c.periodLengthDays, ['день', 'дня', 'дней']) })}
                      </span>
                    </div>
                    {/* Не скрываем исключённые циклы — прячем только их вклад
                        в статистику, а не сам факт, что цикл был. То же для
                        выпавших из выборки прогноза (пропуски в отметках,
                        выброс по длине): раньше такой цикл молча уходил из
                        прогноза, а «в среднем» при этом раздувал. */}
                    {(c.excluded || !data.counted.has(c.startDate)) && (
                      <p className="mt-0.5 text-xs text-muted">{t('не учитывается')}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </Screen>
  );
}

/** Высота и насыщенность заливки идут вместе, но обильность видна и без
 *  цвета — по одной только высоте столбика. Мазня — точка другой формы, а не
 *  тонкая версия того же столбика: спутать «было чуть-чуть» с «было мало, но
 *  это менструация» нельзя, у них разный медицинский смысл. */
const BLEEDING_HEIGHT: Record<'light' | 'medium' | 'heavy', string> = {
  light: 'h-1.5 opacity-60',
  medium: 'h-3.5 opacity-80',
  heavy: 'h-full opacity-100',
};

function DayCell({ cell }: { cell: YearDayCell }) {
  // День, которого в этом месяце не существует (30 февраля и т.п.) — пустая
  // колонка без рамки: цвет ячейки сигналил бы «сюда есть что смотреть», а
  // смотреть здесь нечего в принципе, не «пока нет данных».
  if (!cell.date) return <div className="h-6 flex-1" aria-hidden />;

  const isSpotting = cell.bleeding === 'spotting';
  const heightClass =
    cell.bleeding && cell.bleeding !== 'spotting' ? BLEEDING_HEIGHT[cell.bleeding] : undefined;

  return (
    <div
      role={cell.ariaLabel ? 'img' : undefined}
      aria-label={cell.ariaLabel}
      aria-hidden={cell.ariaLabel ? undefined : true}
      className={`relative h-6 flex-1 overflow-hidden rounded-[2px] ${
        cell.future ? 'bg-transparent' : 'bg-surface-2'
      } ${cell.isCycleStart ? 'ring-1 ring-inset ring-accent' : ''}`}
    >
      {heightClass && (
        <span aria-hidden className={`absolute inset-x-0 bottom-0 w-full rounded-t-[1px] bg-danger ${heightClass}`} />
      )}
      {isSpotting && (
        <span aria-hidden className="absolute inset-0 flex items-center justify-center">
          <span className="size-1 rounded-full border border-danger" />
        </span>
      )}
    </div>
  );
}
