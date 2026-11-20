import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import { GFaChevronRight, GFaLightbulb, GFaPlus, GFaSliders } from '../../components/ui/glyphs';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { ensureCycleSetup } from '../../lib/cycle/cycleRepo';
import { todayKey, formatDayRange, addDaysKey } from '../../lib/dates';
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
import { buildPhases } from './phases';
import { SECTION_BY_ID } from '../../lib/sections';

const CycleIcon = SECTION_BY_ID.get('cycle')!.icon;

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

  if (p.confidence === 'population_prior') {
    return {
      title: t('Примерно {range}', { range: formatDayRange(p.lo80, p.hi80) }),
      note: t('Пока это оценка по усреднённым данным, а не по вашим: циклов слишком мало.'),
    };
  }
  if (p.confidence === 'very_wide' || p.confidence === 'wide') {
    // Подпись называет ту причину, по которой интервал действительно широк
    // (predict.ts, wideBecause), а не одну на уровень уверенности: при трёх
    // ровных циклах «заметно разной длины» было неправдой.
    return {
      title: t('Между {range}', { range: formatDayRange(p.lo80, p.hi80, { between: true }) }),
      note:
        p.wideBecause === 'spread'
          ? t('Прогноз ориентировочный: разница между вашими циклами больше двух недель.')
          : p.wideBecause === 'few_cycles'
            ? t('Своих циклов пока мало — разброс взят по усреднённым данным, поэтому диапазон широкий.')
            : p.wideBecause === 'drift'
              ? t('Последние циклы по длине заметно отличаются от прежних, поэтому диапазон широкий.')
              : t('Циклы заметно разной длины, поэтому диапазон широкий.'),
    };
  }
  return {
    title: t('Скорее всего {range}', { range: formatDayRange(p.lo50!, p.hi50!) }),
    note: t('Примерно в четырёх случаях из пяти — между {range}.', {
      range: formatDayRange(p.lo80, p.hi80, { between: true }),
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

  // Полоса фаз строится по средней длине цикла: менструация — по факту
  // текущего цикла (среднее дорисовывает только её продолжение, phases.ts),
  // фертильные дни — по той же карте вероятностей, что и календарь. Без
  // среднего полосу не рисуем: «где я в цикле» без длины цикла — выдумка.
  const cycleLen = stats.averageLength !== undefined ? Math.round(stats.averageLength) : undefined;
  const start = currentDay !== undefined ? addDaysKey(todayKey(), 1 - currentDay) : undefined;
  const phases =
    start !== undefined && cycleLen !== undefined && cycleLen > 0
      ? buildPhases(
          cycleLen,
          data.cycles.find((c) => c.startDate === start)?.periodLengthDays ?? 0,
          Math.round(stats.averagePeriodLength ?? 5),
          start,
          data.fertile,
          currentDay,
        )
      : null;
  const showStats = data.cycles.some((c) => c.lengthDays !== undefined && c.excluded === 0);

  return (
    <Screen
      title={t('Женские дни')}
      backTo="/home"
      right={
        locked ? undefined : (
          <IconButton
            icon={GFaSliders}
            size={ICON.action}
            label={t('Настройки раздела')}
            to="/more/cycle/settings"
            tone="muted"
          />
        )
      }
    >
      {locked ? (
        <CycleLock settings={settings} onUnlock={() => undefined} />
      ) : (
      <div className="space-y-6">
        {!data.hasAnyData && !data.loading ? (
          <EmptyState
            icon={CycleIcon}
            title={t('Пока нет ни одной отметки')}
            hint={t(
              'Отметьте дни последней менструации — и появится календарь. Прогноз включится, когда наберётся хотя бы один полный цикл.',
            )}
          />
        ) : (
          <>
            {/* Карточка «сейчас». Факт (день цикла) и оценка (прогноз) —
                раздельно и разными по весу: факт крупно, оценка мелко и с
                оговоркой. Смешивать их нельзя — человек запомнит оценку как факт. */}
            <section className="card p-5">
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-lh-text-secondary">
                    {currentDay !== undefined ? t('День цикла') : t('Цикл')}
                  </p>
                  <p className="mt-1 text-5xl font-light tabular-nums">
                    {currentDay ?? '—'}
                  </p>
                </div>
                {stats.n > 0 && stats.averageLength !== undefined && (
                  <p className="shrink-0 text-right text-sm text-lh-text-secondary tabular-nums">
                    {t('Цикл в среднем')}
                    <br />
                    <span className="text-[17px] text-lh-text-primary">{formatDays(stats.averageLength)}</span>
                  </p>
                )}
              </div>

              {phases && (
                <div aria-hidden className="mt-5">
                  <div className="flex h-2 gap-[2px] overflow-hidden rounded-full">
                    {phases.runs.map((r, i) => (
                      <i
                        key={i}
                        className={`h-full ${
                          r.kind === 'period' ? 'bg-danger/60' : r.kind === 'fertile' ? 'bg-success/45' : 'bg-lh-surface-2'
                        }`}
                        style={{ width: `${(r.days / phases.total) * 100}%` }}
                      />
                    ))}
                  </div>
                  <div className="relative h-3">
                    <i
                      className="absolute -top-[14px] h-5 w-[3px] -translate-x-1/2 rounded-full bg-lh-text-primary"
                      style={{ left: `${phases.marker}%` }}
                    />
                  </div>
                </div>
              )}

              {forecast && (
                <div className={`${phases ? '' : 'mt-4'} border-t border-lh-border pt-3`}>
                  <p className="text-sm text-lh-text-secondary">{t('Следующая менструация')}</p>
                  <p className="mt-0.5 text-lg font-light">{forecast.title}</p>
                  {forecast.note && (
                    <p className="mt-1 text-xs leading-snug text-lh-text-secondary">{forecast.note}</p>
                  )}
                  {prediction.daysPastPrediction > 0 && (
                    // Сознательно не «задержка»: это слово подразумевает вывод,
                    // который приложение делать не вправе.
                    <p className="mt-1.5 text-xs leading-snug text-lh-text-secondary">
                      {t('Прошло на {n} больше ожидаемого. У циклов бывает разброс — это само по себе ни о чём не говорит.', {
                        n: tPlur(prediction.daysPastPrediction, ['день', 'дня', 'дней']),
                      })}
                    </p>
                  )}
                </div>
              )}
            </section>

            <CycleCalendar
              data={data}
              month={month}
              onMonth={setMonth}
              onPick={(d) => setPickedDate(d)}
            />

            {anomalies.length > 0 && (
              <section aria-label={t('Стоит обратить внимание')}>
                <div className="card divide-y divide-lh-border">
                  {anomalies.map((a) => (
                    <div key={a.kind} className="flex gap-3 px-4 py-3.5">
                      <GFaLightbulb size={ICON.inline} className="mt-0.5 shrink-0 text-lh-accent" />
                      <div className="min-w-0 flex-1 text-sm leading-[1.45]">
                        <p className="font-semibold">{a.title}</p>
                        <p className="mt-0.5 text-lh-text-secondary">{a.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
                {/* Оговорка обязательна и стоит рядом с наблюдениями, а не в
                    настройках: приложение считает по введённым отметкам и не
                    ставит диагнозов. */}
                <p className="mt-2 px-1 text-xs leading-snug text-lh-text-secondary">
                  {t(
                    'Это наблюдения по вашим отметкам, а не диагноз. Приложение ничего не измеряет — только считает то, что ты отметила.',
                  )}
                </p>
              </section>
            )}

            {/* Секция — пока есть хоть один завершённый неисключённый цикл,
                даже если в выборку прогноза не вошёл ни один (stats.n = 0):
                иначе с ней пропадала бы и ссылка на «Обзор за год», где
                выпавший цикл помечен «не учитывается». */}
            {showStats && (
              <section>
                <h2 className="mb-2.5 px-1 lh-section">{t('Статистика')}</h2>
                <div className="card divide-y divide-lh-border">
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
                  <LinkRow to="/more/cycle/year" label={t('Обзор за год')} />
                  <LinkRow to="/more/cycle/report" label={t('Отчёт для врача')} />
                </div>

                {/* Систематический сдвиг — отдельно от MAE: он говорит не
                    «насколько промахивается», а «в какую сторону». Знак bias —
                    daysBetween(predicted, actual): положительный, когда факт
                    наступил ПОЗЖЕ прогноза. */}
                {data.accuracy.n >= 3 &&
                  data.accuracy.bias !== undefined &&
                  Math.abs(data.accuracy.bias) >= 1 && (
                    <p className="mt-2 px-1 text-xs leading-snug text-lh-text-secondary">
                      {t(
                        data.accuracy.bias > 0
                          ? 'Прогноз в среднем на {bias} раньше факта.'
                          : 'Прогноз в среднем на {bias} позже факта.',
                        { bias: formatDays(Math.abs(data.accuracy.bias)) },
                      )}
                    </p>
                  )}

                {data.accuracy.n >= 3 && (
                  <p className="mt-1 px-1 text-xs leading-snug text-lh-text-secondary">
                    {t(
                      'Точность прогноза считается по вашим циклам: обещанный диапазон против факта. Разброс — биологический, а не ошибка программы.',
                    )}
                  </p>
                )}
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

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setPickedDate(todayKey())}
            className="flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-lh-accent text-base font-semibold text-lh-bg active:opacity-80"
          >
            <GFaPlus size={ICON.inline} /> {t('Отметить сегодня')}
          </button>
          {/* Обещание проверяется privacy.test.ts: таблицы раздела не входят
              в синхронизацию и не видны семье. */}
          <p className="px-6 text-center text-xs text-lh-text-secondary">
            {t('Данные раздела не синхронизируются и никому не видны')}
          </p>
        </div>
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
    <div className="flex min-h-12 items-center justify-between gap-3 px-4 py-2.5 text-[15px]">
      {/* Пол ширины подписи: без него длинное значение ужимает её до буквы. */}
      <span className="min-w-[6rem] flex-1">{label}</span>
      <span className="shrink-0 text-right text-lh-text-secondary tabular-nums">{value}</span>
    </div>
  );
}

function LinkRow({ to, label }: { to: string; label: string }) {
  return (
    // state — откуда пришли: по нему «Отчёт для врача» ведёт «Назад» сюда, а
    // не в настройки раздела, куда ведёт вход из них (CycleReportPage).
    <Link
      to={to}
      state={{ from: '/more/cycle' }}
      className="flex min-h-12 items-center justify-between gap-3 px-4 text-[15px] text-lh-accent active:opacity-60"
    >
      <span>{label}</span>
      <GFaChevronRight size={ICON.inline} aria-hidden className="shrink-0" />
    </Link>
  );
}
