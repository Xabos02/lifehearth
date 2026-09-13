import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import {
  Info,
  SlidersHorizontal,
} from 'lucide-react';
import {
  GPlus as Plus,
  GDrop as Droplet,
} from '../../components/ui/glyphs';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { Button } from '../../components/ui/Button';
import { ensureCycleSetup } from '../../lib/cycle/cycleRepo';
import { formatRu, todayKey, formatDayRange } from '../../lib/dates';
import { getLang, t, tPlur, tPlural } from '../../lib/i18n';
import { CycleCalendar } from './CycleCalendar';
import { CycleHabitsCard } from './CycleHabitsCard';
import { DayLogSheet } from './DayLogSheet';
import { useCycleData } from './useCycleData';
import { CycleLock } from './CycleLock';
import { isUnlocked, subscribeLock } from './lockState';
import type { CyclePredictionResult } from '../../lib/cycle/predict';
import { IconButton } from '../../components/ui/IconButton';
import { ICON } from '../../components/ui/icons';

/** Как называем прогноз словами.
 *
 *  Диапазон показывается всегда, одиночная дата — никогда. Ширина диапазона
 *  должна быть постоянным элементом, а не тем, что появляется в плохие времена:
 *  иначе её сужение и расширение читается как поломка, а не как информация
 *  «мой цикл стал стабильнее». Формулировка «±2 дня» запрещена: при типичном
 *  разбросе это интервал, мимо которого промахивается каждый третий цикл,
 *  а «±2» человек читает как «точно». */
function predictionText(p: CyclePredictionResult): { title: string; note?: string } | null {
  if (p.confidence === 'none' || p.lo80 === undefined || p.hi80 === undefined) return null;

  // Начало диапазона сжимается до голого числа только внутри одного месяца:
  // «26–7 сентября» через границу месяца читается как опечатка — месяц начала
  // обязан прозвучать («26 августа – 7 сентября»).
  const range = (from: string, to: string) => {
    if (from === to) return formatRu(from);
    if (from.slice(0, 7) === to.slice(0, 7)) return formatDayRange(from, to);
    return `${formatRu(from)} – ${formatRu(to)}`;
  };

  if (p.confidence === 'population_prior') {
    return {
      title: t('Примерно {range}', { range: range(p.lo80, p.hi80) }),
      note: t('Пока это оценка по усреднённым данным, а не по вашим: циклов слишком мало.'),
    };
  }
  if (p.confidence === 'very_wide') {
    return {
      title: t('Между {range}', { range: range(p.lo80, p.hi80) }),
      note: t('Прогноз ориентировочный: разница между вашими циклами больше двух недель.'),
    };
  }
  if (p.confidence === 'wide') {
    return {
      title: t('Между {range}', { range: range(p.lo80, p.hi80) }),
      note: t('Циклы заметно разной длины, поэтому диапазон широкий.'),
    };
  }
  return {
    title: t('Скорее всего {range}', { range: range(p.lo50!, p.hi50!) }),
    note: t('Обычно попадает в {range} — примерно в четырёх случаях из пяти.', {
      range: range(p.lo80, p.hi80),
    }),
  };
}

export function CyclePage() {
  const data = useCycleData();
  const [month, setMonth] = useState(() => todayKey().slice(0, 7) + '-01');
  const [pickedDate, setPickedDate] = useState<string | null>(null);

  // Справочник симптомов и настройки заводятся при первом открытии раздела, а
  // не при старте приложения: человек, который сюда не заходит, не должен
  // получить в базе таблицы, которые ему не нужны.
  useEffect(() => {
    void ensureCycleSetup();
  }, []);

  const { prediction, currentDay, stats, anomalies, settings } = data;
  const forecast = settings.predictionsEnabled ? predictionText(prediction) : null;

  // Состояние замка живёт в модуле, а не в компоненте: раздел должен
  // оставаться открытым при переходе на его же настройки и обратно, но
  // закрываться при перезагрузке страницы.
  const open = useSyncExternalStore(subscribeLock, isUnlocked, () => false);
  const locked = settings.lock === 'pin' && settings.pin !== undefined && !open;

  return (
    <Screen
      title={t('Женские дни')}
      backTo="/home"
      right={
        locked ? undefined : (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setPickedDate(todayKey())}
            className="shrink-0 rounded-lg px-2 py-2.5 text-sm font-medium text-accent active:opacity-60"
          >
            {t('Отметить')}
          </button>
          {/* ml-2 к зазору: зона касания шире иконки на 3px с каждой стороны,
              и без запаса тап у левого края уходил бы кнопке «Отметить». */}
          <IconButton
            icon={SlidersHorizontal}
            label={t('Настройки раздела')}
            to="/more/cycle/settings"
            tone="muted"
            className="ml-2"
          />
        </div>
        )
      }
    >
      {locked ? (
        <CycleLock settings={settings} onUnlock={() => undefined} />
      ) : (
      <div className="space-y-5">
        {!data.hasAnyData && !data.loading ? (
          <EmptyState
            icon={Droplet}
            title={t('Пока нет ни одной отметки')}
            hint={t(
              'Отметьте дни последней менструации — и появится календарь. Прогноз включится, когда наберётся хотя бы один полный цикл.',
            )}
          />
        ) : (
          <>
            {/* Карточка «сейчас». Показывает факт (день цикла) и оценку
                (прогноз) раздельно и разными по весу: факт крупно, оценка
                мелко и с оговоркой. Смешивать их нельзя — человек запомнит
                оценку как факт. */}
            <div className="card p-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 text-sm font-medium text-muted">
                  {currentDay !== undefined ? t('День цикла') : t('Цикл')}
                </p>
                {stats.n > 0 && stats.averageLength !== undefined && (
                  <p className="shrink-0 text-xs text-muted">
                    {t('в среднем {v}', { v: formatDays(stats.averageLength) })}
                  </p>
                )}
              </div>
              <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">
                {currentDay ?? '—'}
              </p>

              {forecast && (
                <div className="mt-3 rounded-xl bg-surface-2 p-3">
                  <p className="text-xs text-muted">{t('Следующая менструация')}</p>
                  <p className="mt-0.5 font-semibold">{forecast.title}</p>
                  {forecast.note && (
                    <p className="mt-1 text-xs leading-snug text-muted">{forecast.note}</p>
                  )}
                  {prediction.daysPastPrediction > 0 && (
                    // Сознательно не «задержка»: это слово подразумевает вывод,
                    // который приложение делать не вправе.
                    <p className="mt-1.5 text-xs leading-snug text-muted">
                      {t('Прошло на {n} больше ожидаемого. У циклов бывает разброс — это само по себе ни о чём не говорит.', {
                        n: tPlur(prediction.daysPastPrediction, ['день', 'дня', 'дней']),
                      })}
                    </p>
                  )}
                </div>
              )}
            </div>

            <CycleCalendar
              data={data}
              month={month}
              onMonth={setMonth}
              onPick={(d) => setPickedDate(d)}
            />

            {anomalies.length > 0 && (
              <section>
                <h2 className="mb-1.5 flex items-center gap-1.5 px-1 text-sm font-semibold text-muted">
                  <Info size={ICON.inline} className="shrink-0" />
                  {t('Стоит обратить внимание')}
                </h2>
                <div className="card divide-y divide-hairline px-4">
                  {anomalies.map((a) => (
                    <div key={a.kind} className="py-3">
                      <p className="font-medium">{a.title}</p>
                      <p className="mt-0.5 text-sm leading-snug text-muted">{a.detail}</p>
                    </div>
                  ))}
                </div>
                {/* Оговорка обязательна и стоит рядом с наблюдениями, а не в
                    настройках: приложение считает по введённым отметкам и не
                    ставит диагнозов. */}
                <p className="mt-2 px-1 text-xs leading-snug text-muted">
                  {t(
                    'Это наблюдения по вашим отметкам, а не диагноз. Приложение ничего не измеряет — только считает то, что ты отметила.',
                  )}
                </p>
              </section>
            )}

            {stats.n > 0 && (
              <section>
                <h2 className="mb-1.5 px-1 text-sm font-semibold text-muted">{t('Статистика')}</h2>
                <div className="card divide-y divide-hairline px-4">
                  <Row label={t('Циклов учтено')} value={String(stats.n)} />
                  {stats.medianLength !== undefined && (
                    <Row label={t('Обычная длина')} value={formatDays(stats.medianLength)} />
                  )}
                  {stats.shortestLength !== undefined && stats.longestLength !== undefined && (
                    <Row
                      label={t('Самый короткий и длинный')}
                      value={t('{min} и {max}', {
                        min: stats.shortestLength,
                        max: formatDays(stats.longestLength),
                      })}
                    />
                  )}
                  {stats.variability !== undefined && (
                    <Row
                      label={t('Разница между соседними')}
                      value={formatDays(stats.variability)}
                    />
                  )}
                  {stats.averagePeriodLength !== undefined && (
                    <Row label={t('Менструация')} value={formatDays(stats.averagePeriodLength)} />
                  )}
                  {/* Точность прогноза — то, чего не показывает ни один
                      конкурент. Цифра может оказаться неприятной; смягчать её
                      нельзя, можно только объяснить, что разброс биологический. */}
                  {data.accuracy.n >= 3 && (
                    <Row
                      label={t('Прогноз сбывался')}
                      value={
                        data.accuracy.mae === undefined
                          ? t('{done} из {total}', { done: data.accuracy.hits ?? 0, total: data.accuracy.n })
                          : t('{done} из {total}, ошибка {mae}', {
                              done: data.accuracy.hits ?? 0,
                              total: data.accuracy.n,
                              mae: formatDays(data.accuracy.mae),
                            })
                      }
                    />
                  )}
                </div>

                {/* Систематический сдвиг — отдельно от MAE: он говорит не
                    «насколько промахивается», а «в какую сторону», и это
                    лечится иначе (сдвигом константы, а не переписыванием
                    формулы). Знак bias — daysBetween(predicted, actual):
                    положительный, когда факт наступил ПОЗЖЕ прогноза, то
                    есть прогноз оказался раньше факта. */}
                {data.accuracy.n >= 3 &&
                  data.accuracy.bias !== undefined &&
                  Math.abs(data.accuracy.bias) >= 1 && (
                    <p className="mt-2 px-1 text-xs leading-snug text-muted">
                      {t(
                        data.accuracy.bias > 0
                          ? 'Прогноз в среднем на {bias} раньше факта.'
                          : 'Прогноз в среднем на {bias} позже факта.',
                        { bias: formatDays(Math.abs(data.accuracy.bias)) },
                      )}
                    </p>
                  )}

                {/* Оговорка про биологическую природу разброса — рядом с
                    самой точностью, а не в настройках: цифра может быть
                    неприятной, и смягчать её нельзя, можно только объяснить. */}
                {data.accuracy.n >= 3 && (
                  <p className="mt-1 px-1 text-xs leading-snug text-muted">
                    {t(
                      'Точность прогноза считается по вашим циклам: обещанный диапазон против факта. Разброс — биологический, а не ошибка программы.',
                    )}
                  </p>
                )}

                {/* stats.n > 0 гарантирован секцией выше: отдельная проверка
                    здесь не нужна, но ссылка обязана появляться только внутри
                    неё — статистики без данных не бывает, а обзор года без
                    единого цикла показывать нечего. */}
                <Link
                  to="/more/cycle/year"
                  className="mt-3 inline-block px-1 text-sm font-medium text-accent"
                >
                  {t('Обзор за год →')}
                </Link>
              </section>
            )}

            {/* Монтируем только при включённом тумблере: у того, кто связку не
                просил, не должно быть даже запроса к таблицам привычек из
                этого раздела. */}
            {settings.integrations.habitsCorrelation && (
              <CycleHabitsCard cycles={data.cycles} />
            )}
          </>
        )}

        {!data.hasAnyData && !data.loading && (
          <Button onClick={() => setPickedDate(todayKey())} className="w-full">
            <Plus size={ICON.base} className="-mt-0.5 mr-1 inline" /> {t('Отметить сегодня')}
          </Button>
        )}
      </div>

      )}

      <DayLogSheet
        open={pickedDate !== null && !locked}
        date={pickedDate}
        onClose={() => setPickedDate(null)}
      />
    </Screen>
  );
}

/** «28 дней», но «28,4 дня»: при дробном числе русский требует родительного
 *  падежа единственного числа, и обычная плюрализация по последней цифре здесь
 *  даёт «28.4 дней». Заодно переводим точку в запятую. */
function formatDays(v: number): string {
  const isFraction = !Number.isInteger(v);
  const ru = getLang() === 'ru';
  const text = ru ? String(v).replace('.', ',') : String(v);
  return `${text}\u00A0${isFraction && ru ? 'дня' : tPlural(v, ['день', 'дня', 'дней'])}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-3">
      {/* Пол ширины подписи: без него длинное значение ужимает её до буквы. */}
      <span className="min-w-[6rem] flex-1 text-sm text-muted">{label}</span>
      <span className="shrink-0 font-semibold tabular-nums">{value}</span>
    </div>
  );
}
