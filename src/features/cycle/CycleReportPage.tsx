import { useMemo, useState, useSyncExternalStore } from 'react';
import { Printer } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Screen } from '../../components/layout/Screen';
import { Button } from '../../components/ui/Button';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { db } from '../../db/db';
import { formatDayRange, formatRangeToWord, formatRu } from '../../lib/dates';
import { getLang, t, tPlur, tPlural } from '../../lib/i18n';
import { buildDoctorReport, type DoctorReportWindow } from '../../lib/cycle/report';
import { useCycleData } from './useCycleData';
import { CycleLock } from './CycleLock';
import { isUnlocked, subscribeLock } from './lockState';
import { ICON } from '../../components/ui/icons';

const WINDOW_OPTIONS: { value: DoctorReportWindow; label: string }[] = [
  { value: 'last2cycles', label: '2 цикла' },
  { value: '6months', label: '6 месяцев' },
  { value: '12months', label: '12 месяцев' },
];

/** «28 дней», но «28,4 дня» — как в CyclePage.tsx: при дробном числе нужен
 *  родительный падеж единственного числа, а не форма по последней цифре
 *  (иначе «28.4 дней»). Своя копия здесь, а не импорт из CyclePage: там
 *  функция не экспортирована, а трогать этот файл в рамках задачи нельзя. */
function formatDays(v: number): string {
  const isFraction = !Number.isInteger(v);
  const ru = getLang() === 'ru';
  const text = ru ? String(v).replace('.', ',') : String(v);
  return `${text}\u00A0${isFraction && ru ? 'дня' : tPlural(v, ['день', 'дня', 'дней'])}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-3">
      <span className="min-w-[6rem] flex-1 text-sm text-lh-text-secondary">{label}</span>
      <span className="shrink-0 font-semibold tabular-nums">{value}</span>
    </div>
  );
}

export function CycleReportPage() {
  const data = useCycleData();
  const episodes = useLiveQuery(() => db.cycleEpisodes.toArray(), []) ?? [];
  const symptomDefs = useLiveQuery(() => db.cycleSymptoms.toArray(), []) ?? [];
  const [reportWindow, setReportWindow] = useState<DoctorReportWindow>('6months');

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

  return (
    <Screen title={t('Отчёт для врача')} backTo="/more/cycle/settings">
      {locked ? (
        <CycleLock settings={data.settings} onUnlock={() => undefined} />
      ) : (
        <div className="space-y-5">
          {/* Переключатель окна — только на экране, в печать не идёт. */}
          <div className="print:hidden">
            <SegmentedControl
              options={WINDOW_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
              value={reportWindow}
              onChange={setReportWindow}
            />
          </div>

          {/* Дальше — само содержимое отчёта: то, что уходит на печать целиком. */}
          <div className="space-y-5">
            <div className="card p-4">
              <p className="text-sm text-lh-text-secondary">
                {t('Составлено {date}', { date: formatRu(report.generatedAt, 'd MMMM yyyy') })}
              </p>
              <p className="mt-0.5 font-semibold">{t('Период: {period}', { period: periodText })}</p>
            </div>

            <section>
              <h2 className="mb-1.5 px-1 lh-section">{t('Циклы периода')}</h2>
              {report.cycles.length === 0 ? (
                <div className="card p-4">
                  <p className="text-sm text-lh-text-secondary">{t('За выбранный период отметок нет.')}</p>
                </div>
              ) : (
                <div className="card divide-y divide-lh-border px-4">
                  {report.cycles.map((c) => (
                    <div key={c.startDate} className="py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-medium">{formatRu(c.startDate, 'd MMMM yyyy')}</span>
                        <span className="shrink-0 text-sm tabular-nums text-lh-text-secondary">
                          {c.lengthDays !== undefined ? formatDays(c.lengthDays) : t('Текущий')}
                        </span>
                      </div>
                      {c.periodLengthDays !== undefined && (
                        <p className="mt-0.5 text-sm text-lh-text-secondary">
                          {t('Менструация: {days}', { days: formatDays(c.periodLengthDays) })}
                        </p>
                      )}
                      {c.excluded && (
                        <p className="mt-0.5 text-sm text-lh-text-secondary">
                          {t('Исключён из статистики{reason}', {
                            reason: c.excludeReasonLabel ? ` — ${c.excludeReasonLabel}` : '',
                          })}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {report.stats.n > 0 && (
              <section>
                <h2 className="mb-1.5 px-1 lh-section">{t('Статистика периода')}</h2>
                <div className="card divide-y divide-lh-border px-4">
                  <Row label={t('Завершённых циклов')} value={String(report.stats.n)} />
                  {report.stats.medianLength !== undefined && (
                    <Row label={t('Медианная длина')} value={formatDays(report.stats.medianLength)} />
                  )}
                  {report.stats.shortestLength !== undefined && report.stats.longestLength !== undefined && (
                    <Row
                      label={t('Мин. и макс. длина')}
                      value={t('{min} и {max}', {
                        min: report.stats.shortestLength,
                        max: formatDays(report.stats.longestLength),
                      })}
                    />
                  )}
                  {report.stats.spread !== undefined && (
                    <Row label={t('Размах')} value={formatDays(report.stats.spread)} />
                  )}
                </div>
              </section>
            )}

            {report.symptomFrequency.length > 0 && (
              <section>
                <h2 className="mb-1.5 px-1 lh-section">{t('Симптомы')}</h2>
                <div className="card divide-y divide-lh-border px-4">
                  {report.symptomFrequency.map((s) => (
                    <Row key={s.key} label={s.label} value={tPlur(s.days, ['день', 'дня', 'дней'])} />
                  ))}
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-1.5 px-1 lh-section">{t('Кровотечение по дням')}</h2>
              <div className="card divide-y divide-lh-border px-4">
                {report.bleedingDays.map((b) => (
                  <Row key={b.level} label={b.label} value={tPlur(b.days, ['день', 'дня', 'дней'])} />
                ))}
              </div>
            </section>

            {report.episodes.length > 0 && (
              <section>
                <h2 className="mb-1.5 px-1 lh-section">{t('Эпизоды')}</h2>
                <div className="card divide-y divide-lh-border px-4">
                  {report.episodes.map((e, i) => (
                    <div key={`${e.kind}-${e.startDate}-${i}`} className="py-3">
                      <p className="font-medium">{e.label}</p>
                      <p className="mt-0.5 text-sm text-lh-text-secondary">
                        {e.endDate
                          ? formatDayRange(e.startDate, e.endDate, { year: true })
                          : formatRangeToWord(e.startDate, t('продолжается'), 'd MMMM yyyy')}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {report.anomalies.length > 0 && (
              <section>
                <h2 className="mb-1.5 px-1 lh-section">{t('Стоит обратить внимание')}</h2>
                <div className="card divide-y divide-lh-border px-4">
                  {report.anomalies.map((a) => (
                    <div key={a.kind} className="py-3">
                      <p className="font-medium">{a.title}</p>
                      <p className="mt-0.5 text-sm leading-snug text-lh-text-secondary">{a.detail}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Дисклеймер — часть отчёта, печатается вместе с остальным
                содержимым: врач должен видеть его на бумаге, а не только на
                экране перед печатью. */}
            <p className="px-1 text-xs leading-snug text-lh-text-secondary">
              {t('Составлено по отметкам в приложении. Приложение ничего не измеряет и не ставит диагнозов.')}
            </p>
          </div>

          <div className="print:hidden space-y-2">
            <Button className="w-full" onClick={() => window.print()}>
              <Printer size={ICON.base} className="-mt-0.5 mr-1 inline" strokeWidth={2} />
              {t('Распечатать или сохранить в PDF')}
            </Button>
            <p className="px-1 text-xs leading-snug text-lh-text-secondary">
              {t('Распечатка и сохранённый файл не защищены замком раздела.')}
            </p>
          </div>
        </div>
      )}
    </Screen>
  );
}
