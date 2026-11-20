import { Fragment, useMemo, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLocation } from 'react-router';
import { Screen } from '../../components/layout/Screen';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { db } from '../../db/db';
import { formatDayRange, formatRangeToWord, formatRu } from '../../lib/dates';
import { getLang, t, tPlur, tPlural } from '../../lib/i18n';
import { buildDoctorReport, type DoctorReportWindow } from '../../lib/cycle/report';
import { useCycleData } from './useCycleData';
import { CycleLock } from './CycleLock';
import { isUnlocked, subscribeLock } from './lockState';
import { ICON } from '../../components/ui/icons';
import { GFaFileLines, GFaPrint } from '../../components/ui/glyphs';

const WINDOW_OPTIONS: { value: DoctorReportWindow; label: string }[] = [
  { value: 'last2cycles', label: '2 цикла' },
  { value: '6months', label: '6 месяцев' },
  { value: '12months', label: '12 месяцев' },
];

/** «28 дней», но «28,4 дня» — как в CyclePage.tsx: при дробном числе нужен
 *  родительный падеж единственного числа, а не форма по последней цифре
 *  (иначе «28.4 дней»). Своя копия здесь: в CyclePage функция не экспортирована. */
function formatDays(v: number): string {
  const isFraction = !Number.isInteger(v);
  const ru = getLang() === 'ru';
  const text = ru ? String(v).replace('.', ',') : String(v);
  return `${text}\u00A0${isFraction && ru ? 'дня' : tPlural(v, ['день', 'дня', 'дней'])}`;
}

/** Плитка ключевой цифры в шапке отчёта. Нет данных — прочерк, а не ноль:
 *  ноль дней менструации врач прочтёт как факт. */
function Kpi({ value, label, first }: { value?: number | string; label: string; first?: boolean }) {
  const text = value === undefined ? '—' : typeof value === 'number' ? fmtNum(value) : value;
  return (
    <div className={`min-w-0 px-4 py-4 ${first ? '' : 'border-l border-lh-border'}`}>
      <div className="text-2xl font-light leading-none tabular-nums">{text}</div>
      <div className="mt-1.5 text-xs leading-snug text-lh-text-secondary">{label}</div>
    </div>
  );
}

const fmtNum = (v: number) => (getLang() === 'ru' ? String(v).replace('.', ',') : String(v));

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-lh-border px-5 pb-4 pt-3.5">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );
}

export function CycleReportPage() {
  const data = useCycleData();
  const episodes = useLiveQuery(() => db.cycleEpisodes.toArray(), []) ?? [];
  const symptomDefs = useLiveQuery(() => db.cycleSymptoms.toArray(), []) ?? [];
  const [reportWindow, setReportWindow] = useState<DoctorReportWindow>('6months');
  // «Назад» — туда, откуда открыли: из «Статистики» на корне раздела (ссылка
  // передаёт state) — на корень, иначе — на родителя по §12, в настройки.
  // Принимаем только известное значение: state живёт в истории и может быть
  // любым.
  const fromRoot = (useLocation().state as { from?: string } | null)?.from === '/more/cycle';

  // Замок раздела — тот же паттерн, что в CyclePage.tsx: разблокировка живёт в
  // памяти модуля и не переживает перезагрузку страницы.
  const open = useSyncExternalStore(subscribeLock, isUnlocked, () => false);
  const locked = data.settings.lock === 'pin' && data.settings.pin !== undefined && !open;

  const report = useMemo(
    () =>
      buildDoctorReport({
        days: data.days,
        cycles: data.cycles,
        episodes,
        symptoms: symptomDefs,
        anomalies: data.anomalies,
        window: reportWindow,
        today: data.today,
      }),
    [data.days, data.cycles, episodes, symptomDefs, data.anomalies, reportWindow, data.today],
  );

  const periodText = formatDayRange(report.periodFrom, report.periodTo, { year: true });

  const maxSymptomDays = Math.max(1, ...report.symptomFrequency.map((x) => x.days));

  return (
    <Screen
      title={t('Отчёт для врача')}
      subtitle={locked ? undefined : t('Сводка циклов и симптомов, которую удобно показать на приёме. Формируется на устройстве.')}
      backTo={fromRoot ? '/more/cycle' : '/more/cycle/settings'}
    >
      {locked ? (
        <CycleLock settings={data.settings} onUnlock={() => undefined} />
      ) : (
        <div className="space-y-6">
          {/* Переключатель окна — только на экране, в печать не идёт. */}
          <section className="print:hidden">
            <h2 className="mb-2.5 px-1 lh-section">{t('Период')}</h2>
            <SegmentedControl
              options={WINDOW_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
              value={reportWindow}
              onChange={setReportWindow}
            />
          </section>

          {/* Дальше — сам отчёт: то, что уходит на печать целиком. */}
          <article className="card overflow-hidden">
            <div className="px-5 pb-4 pt-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-[.08em] text-lh-text-secondary print:hidden">
                    {t('Предпросмотр')}
                  </p>
                  <p className="mt-1.5 text-lg font-semibold">{t('Менструальный цикл')}</p>
                  <p className="mt-0.5 text-sm text-lh-text-secondary tabular-nums">
                    {periodText} · {tPlur(report.cycles.length, ['цикл', 'цикла', 'циклов'])}
                  </p>
                </div>
                <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 text-lh-accent">
                  <GFaFileLines size={ICON.action} />
                </span>
              </div>
              <p className="mt-3 text-xs text-lh-text-secondary">
                {t('Составлено {date}', { date: formatRu(report.generatedAt, 'd MMMM yyyy') })}
              </p>
            </div>

            <div className="grid grid-cols-3 border-t border-lh-border">
              <Kpi first value={report.stats.medianLength} label={t('Обычный цикл, дн.')} />
              <Kpi value={report.stats.averagePeriodLength} label={t('Менструация, дн.')} />
              <Kpi value={report.stats.spread} label={t('Размах, дн.')} />
            </div>

            <Block title={t('Циклы')}>
              {report.cycles.length === 0 ? (
                <p className="text-sm text-lh-text-secondary">{t('За выбранный период отметок нет.')}</p>
              ) : (
                <>
                  {/* Шапка колонок прозвучала бы один раз над всеми строками — диктору
                      она не нужна: каждая ячейка ниже несёт свою подпись (sr-only). */}
                  <div aria-hidden className="grid grid-cols-[1fr_auto_auto] gap-x-5 border-b border-lh-border pb-1.5 text-xs text-lh-text-secondary">
                    <span>{t('Начало')}</span>
                    <span className="text-right">{t('Длина')}</span>
                    <span className="w-14 text-right">{t('Менстр.')}</span>
                  </div>
                  <div className="divide-y divide-lh-border text-sm tabular-nums">
                    {report.cycles.map((c) => (
                      <div key={c.startDate} className="py-2.5">
                        <div className="grid grid-cols-[1fr_auto_auto] gap-x-5">
                          <span>{formatRu(c.startDate, 'd MMMM yyyy')}</span>
                          <span className={`text-right ${c.lengthDays === undefined ? 'text-lh-text-secondary' : ''}`}>
                            <span aria-hidden>{c.lengthDays ?? t('идёт')}</span>
                            <span className="sr-only">
                              {`${t('Длина')}: ${c.lengthDays === undefined ? t('идёт') : formatDays(c.lengthDays)}`}
                            </span>
                          </span>
                          <span className="w-14 text-right">
                            <span aria-hidden>{c.periodLengthDays ?? '—'}</span>
                            <span className="sr-only">
                              {t('Менструация: {days}', {
                                days: c.periodLengthDays === undefined ? '—' : formatDays(c.periodLengthDays),
                              })}
                            </span>
                          </span>
                        </div>
                        {c.excluded && (
                          <p className="mt-0.5 text-xs text-lh-text-secondary">
                            {t('Исключён из статистики{reason}', {
                              reason: c.excludeReasonLabel ? ` — ${c.excludeReasonLabel}` : '',
                            })}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Block>

            {report.stats.n > 0 &&
              report.stats.shortestLength !== undefined &&
              report.stats.longestLength !== undefined && (
                <Block title={t('Статистика периода')}>
                  <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[13px]">
                    <span className="text-lh-text-secondary">{t('Завершённых циклов')}</span>
                    <span className="text-right tabular-nums">{report.stats.n}</span>
                    <span className="text-lh-text-secondary">{t('Мин. и макс. длина')}</span>
                    <span className="text-right tabular-nums">
                      {t('{min} и {max}', {
                        min: report.stats.shortestLength,
                        max: formatDays(report.stats.longestLength),
                      })}
                    </span>
                  </div>
                </Block>
              )}

            {report.symptomFrequency.length > 0 && (
              <Block title={t('Частые симптомы')}>
                <div className="space-y-2.5 text-[13px]">
                  {report.symptomFrequency.map((x) => (
                    <div key={x.key} className="flex items-center gap-3">
                      <span className="w-28 min-w-0 shrink-0 break-words">{x.label}</span>
                      <span aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-full bg-lh-surface-2">
                        <i
                          className="block h-full bg-lh-accent"
                          style={{ width: `${Math.round((x.days / maxSymptomDays) * 100)}%` }}
                        />
                      </span>
                      <span className="w-14 shrink-0 text-right tabular-nums text-lh-text-secondary">
                        {tPlur(x.days, ['день', 'дня', 'дней'])}
                      </span>
                    </div>
                  ))}
                </div>
              </Block>
            )}

            <Block title={t('Кровотечение по дням')}>
              <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[13px]">
                {report.bleedingDays.map((b) => (
                  <Fragment key={b.level}>
                    <span className="text-lh-text-secondary">{b.label}</span>
                    <span className="text-right tabular-nums">{tPlur(b.days, ['день', 'дня', 'дней'])}</span>
                  </Fragment>
                ))}
              </div>
            </Block>

            {report.episodes.length > 0 && (
              <Block title={t('Эпизоды')}>
                <div className="space-y-2 text-[13px]">
                  {report.episodes.map((e, i) => (
                    <div key={`${e.kind}-${e.startDate}-${i}`}>
                      <p className="font-medium">{e.label}</p>
                      <p className="text-lh-text-secondary">
                        {e.endDate
                          ? formatDayRange(e.startDate, e.endDate, { year: true })
                          : formatRangeToWord(e.startDate, t('продолжается'), 'd MMMM yyyy')}
                      </p>
                    </div>
                  ))}
                </div>
              </Block>
            )}

            {report.anomalies.length > 0 && (
              <Block title={t('Стоит обратить внимание')}>
                <div className="space-y-2 text-[13px]">
                  {report.anomalies.map((a) => (
                    <div key={a.kind}>
                      <p className="font-medium">{a.title}</p>
                      <p className="leading-snug text-lh-text-secondary">{a.detail}</p>
                    </div>
                  ))}
                </div>
              </Block>
            )}

            {/* Дисклеймер — часть отчёта, печатается вместе с остальным
                содержимым: врач должен видеть его на бумаге. */}
            <p className="border-t border-lh-border px-5 py-3.5 text-xs leading-snug text-lh-text-secondary">
              {t('Составлено по отметкам в приложении. Приложение ничего не измеряет и не ставит диагнозов.')}
            </p>
          </article>

          <div className="print:hidden space-y-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-lh-accent text-base font-semibold text-lh-bg active:opacity-80"
            >
              <GFaPrint size={ICON.inline} />
              {t('Распечатать или сохранить в PDF')}
            </button>
            <p className="px-1 text-center text-xs leading-snug text-lh-text-secondary">
              {t('Распечатка и сохранённый файл не защищены замком раздела.')}
            </p>
          </div>
        </div>
      )}
    </Screen>
  );
}
