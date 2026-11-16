import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { Gauge, HeartPulse, Moon, Weight, type LucideIcon } from 'lucide-react';
import { ICON } from '../../components/ui/icons';
import { GPlus as Plus } from '../../components/ui/glyphs';
import { getLang, t } from '../../lib/i18n';
import { formatRu, isDateKey, todayKey } from '../../lib/dates';
import type { MetricLog } from '../../db/types';
import { useLoaded } from '../../hooks/useLoaded';
import {
  MEASURES,
  formatMeasure,
  logMeasure,
  measureDef,
  measureLogId,
  measureTrend,
  removeMeasureLog,
  type MeasureKey,
  type MeasureDef,
} from './measures';
import { confirmAction } from '../../components/ui/confirmStore';

/** Вкладка «Здоровье»: четыре замера с трендом за 30 дней. Дневник, не
 *  диагностика: числа и линия, без выводов. Давление — две метрики в одной
 *  карточке: верхнее и нижнее вводятся вместе, показываются через дробь. */
export function MeasuresTab() {
  const today = todayKey();
  // Порядок «день месяц» — по языку (PROTOCOL §7.7): с фиксированным 'd MMM'
  // английский показывал «16 Sep» вместо «Sep 16».
  const ru = getLang() === 'ru';
  const logs = useLiveQuery(() => db.metricLogs.toArray(), []);
  const loaded = useLoaded(logs);
  const [editing, setEditing] = useState<MeasureKey | null>(null);

  const byMetric = useMemo(() => {
    const m = new Map<string, MetricLog[]>();
    for (const l of logs ?? []) m.set(l.metricId, [...(m.get(l.metricId) ?? []), l]);
    return m;
  }, [logs]);
  const trend = (key: MeasureKey) => measureTrend(byMetric.get(measureDef(key).id) ?? [], today);

  const weight = trend('weight');
  const sleep = trend('sleep');
  const pulse = trend('pulse');
  const sys = trend('bpSys');
  const dia = trend('bpDia');
  const hb = trend('hemoglobin');
  const fer = trend('ferritin');

  // До ответа базы — ничего: иначе на первом кадре мелькает «Замеров пока нет».
  if (!loaded) return null;

  return (
    <div className="space-y-3">
      <MeasureCard
        icon={Weight}
        def={measureDef('weight')}
        value={weight.last ? formatMeasure(weight.last.value, measureDef('weight')) : null}
        sub={
          weight.last
            ? [
                weight.delta30 !== null ? t('{d} за 30 дней', { d: signed(weight.delta30) }) : null,
                weight.avg7 !== null ? t('среднее за неделю {v}', { v: formatMeasure(weight.avg7, measureDef('weight')) }) : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : t('Замеров пока нет')
        }
        series={weight.series.map((p) => p.value)}
        onAdd={() => setEditing('weight')}
      />
      <MeasureCard
        icon={Moon}
        def={measureDef('sleep')}
        value={sleep.avg7 !== null ? hours(sleep.avg7) : null}
        unitOverride=""
        sub={
          sleep.last
            ? t('среднее за неделю · последний {when}: {v}', {
                when: formatRu(sleep.last.date, ru ? 'd MMM' : 'MMM d'),
                v: hours(sleep.last.value),
              })
            : t('Замеров пока нет')
        }
        series={sleep.series.map((p) => p.value)}
        onAdd={() => setEditing('sleep')}
      />
      <div className="grid grid-cols-2 gap-3">
      <MeasureCard
        compact
        icon={HeartPulse}
        def={measureDef('pulse')}
        value={pulse.last ? formatMeasure(pulse.last.value, measureDef('pulse')) : null}
        sub={
          pulse.last
            ? pulse.delta30 !== null
              ? t('{d} за 30 дней · утром, до кофе', { d: signed(pulse.delta30, 0) })
              : t('утром, до кофе')
            : t('Замеров пока нет')
        }
        series={pulse.series.map((p) => p.value)}
        onAdd={() => setEditing('pulse')}
      />
      <MeasureCard
        compact
        icon={Gauge}
        def={{ ...measureDef('bpSys'), title: t('Давление') }}
        value={sys.last && dia.last ? `${Math.round(sys.last.value)} / ${Math.round(dia.last.value)}` : null}
        sub={sys.last ? formatRu(sys.last.date) : t('Замеров пока нет')}
        series={sys.series.map((p) => p.value)}
        onAdd={() => setEditing('bpSys')}
      />
      </div>
      <h2 className="px-1 pt-3 lh-section">{t('Из анализов')}</h2>
      <div className="card divide-y divide-lh-border">
      {([hb, fer] as const).map((tr, i) => {
        const def = measureDef(i === 0 ? 'hemoglobin' : 'ferritin');
        return (
          <LabRow
            key={def.key}
            def={def}
            value={tr.last ? formatMeasure(tr.last.value, def) : null}
            sub={
              tr.last
                ? tr.deltaPrev !== null
                  ? t('{d} к прошлому · {when}', {
                      d: signed(tr.deltaPrev, 0),
                      when: formatRu(tr.last.date, ru ? 'd MMM yyyy' : 'MMM d, yyyy'),
                    })
                  : formatRu(tr.last.date, ru ? 'd MMMM yyyy' : 'MMMM d, yyyy')
                : t('Замеров пока нет')
            }
            onAdd={() => setEditing(def.key)}
          />
        );
      })}
      </div>
      <p className="px-1 text-xs leading-snug text-lh-text-secondary">
        {t('Замеры вводятся руками: Apple Health веб-приложению закрыт. Второй замер за день заменяет первый. Норм приложение не знает — их сверяйте с бланком лаборатории.')}
      </p>

      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing ? t(editing === 'bpSys' ? 'Давление' : measureDef(editing).title) : ''}>
        {editing && <MeasureForm key={editing} measure={editing} onClose={() => setEditing(null)} />}
      </Sheet>
    </div>
  );
}

function MeasureCard({
  def,
  icon: Icon,
  value,
  unitOverride,
  sub,
  series,
  onAdd,
  compact = false,
}: {
  def: MeasureDef;
  icon: LucideIcon;
  value: string | null;
  unitOverride?: string;
  sub: string;
  series: number[];
  onAdd: () => void;
  compact?: boolean;
}) {
  const unit = unitOverride ?? def.unit;
  const addButton = (
    <button
      type="button"
      onClick={onAdd}
      className={`inline-flex h-11 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 px-3.5 text-sm text-lh-accent active:opacity-60 ${compact ? 'mt-3 w-full' : ''}`}
    >
      {t('+ замер')}
    </button>
  );
  const head = (
    <>
      <h2 className="flex items-center gap-2 text-xs text-lh-text-secondary">
        <Icon size={ICON.inline} className="shrink-0" />
        {t(def.title)}
      </h2>
      <p className={`mt-1 font-light leading-tight tabular-nums ${compact ? 'text-2xl' : 'text-3xl'}`}>
        {value ?? '—'}
        {value && unit ? <span className="ml-1 text-sm text-lh-text-secondary">{t(unit)}</span> : null}
      </p>
    </>
  );

  if (compact) {
    return (
      <section className="card flex min-w-0 flex-col p-4" data-testid={`measure-${def.key}`}>
        {head}
        <p className="mt-1.5 text-2xs leading-snug text-lh-text-secondary">{sub}</p>
        <div className="mt-auto">
          {series.length >= 2 && <Sparkline values={series} className="mt-3 h-7 w-full" />}
          {addButton}
        </div>
      </section>
    );
  }

  return (
    <section className="card p-4" data-testid={`measure-${def.key}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">{head}</div>
        {series.length >= 2 && <Sparkline values={series} dot className="mt-1 h-12 w-[120px] shrink-0" />}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-lh-border pt-3">
        <p className="min-w-0 text-xs text-lh-text-secondary">{sub}</p>
        {addButton}
      </div>
    </section>
  );
}

/** Строка показателя из анализов: значение справа, тап — новый замер. */
function LabRow({ def, value, sub, onAdd }: { def: MeasureDef; value: string | null; sub: string; onAdd: () => void }) {
  return (
    <div className="flex items-center gap-3 py-2 pl-4 pr-2" data-testid={`measure-${def.key}`}>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{t(def.title)}</span>
        <span className="block text-xs text-lh-text-secondary">{sub}</span>
      </span>
      <span className="shrink-0 text-right tabular-nums">
        {value ?? '—'}
        {value && def.unit ? <span className="ml-1 text-xs text-lh-text-secondary">{t(def.unit)}</span> : null}
      </span>
      <button
        type="button"
        onClick={onAdd}
        aria-label={`${t('+ замер')}: ${t(def.title)}`}
        className="flex size-11 shrink-0 items-center justify-center rounded-xl text-lh-accent active:opacity-60"
      >
        <Plus size={ICON.action} />
      </button>
    </div>
  );
}

/** Линия тренда без осей: достаточно увидеть направление. Цвет — золото
 *  интерфейса, точка отмечает последний замер. */
function Sparkline({ values, className, dot = false }: { values: number[]; className: string; dot?: boolean }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const xy = values.map((v, i) => [(i / (values.length - 1)) * 120, 44 - ((v - min) / span) * 40] as const);
  const pts = xy.map(([x, y]) => `${x},${y}`).join(' ');
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg viewBox="-3 0 126 48" preserveAspectRatio="none" className={className} aria-hidden>
      <polyline
        fill="none"
        stroke="var(--lh-accent)"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        points={pts}
      />
      {dot && <circle cx={lx} cy={ly} r="2.5" fill="var(--lh-accent)" />}
    </svg>
  );
}

function MeasureForm({ measure, onClose }: { measure: MeasureKey; onClose: () => void }) {
  const def = measureDef(measure);
  const isBp = measure === 'bpSys';
  const [day, setDay] = useState(todayKey());
  const [raw, setRaw] = useState('');
  const [raw2, setRaw2] = useState('');
  const num = (s: string) => Number(s.replace(',', '.'));
  const v1 = num(raw);
  const v2 = num(raw2);
  const okRange = (v: number, d: MeasureDef) => Number.isFinite(v) && v >= d.min && v <= d.max;
  const canSave =
    raw !== '' && okRange(v1, def) && (!isBp || (raw2 !== '' && okRange(v2, measureDef('bpDia')))) && isDateKey(day) && day <= todayKey();
  // Замер за выбранный день уже есть — его можно удалить (ошибочный «784»).
  const existing = useLiveQuery(() => db.metricLogs.get(measureLogId(def.id, day)), [def.id, day]);
  const hasExisting = Boolean(existing && !existing.deletedAt);
  // Защита от дабл-тапа: второй тап по «Сохранить» до записи создавал второй лог.
  const savingRef = useRef(false);

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await logMeasure(measure, day, v1);
      if (isBp) await logMeasure('bpDia', day, v2);
      onClose();
    } finally {
      savingRef.current = false;
    }
  };

  const del = async () => {
    if (!(await confirmAction(t('Удалить замер за этот день?')))) return;
    await removeMeasureLog(measureLogId(def.id, day));
    if (isBp) await removeMeasureLog(measureLogId(measureDef('bpDia').id, day));
    onClose();
  };

  return (
    <div className="space-y-4 pb-2">
      <Field label={t('Когда')}>
        <Input type="date" value={day} max={todayKey()} onChange={(e: ChangeEvent<HTMLInputElement>) => setDay(e.target.value)} />
      </Field>
      <div className={isBp ? 'flex gap-3' : ''}>
        <Field label={isBp ? t('Верхнее') : `${t(def.title)}, ${t(def.unit)}`} className={isBp ? 'flex-1' : ''}>
          <Input
            inputMode="decimal"
            autoFocus
            value={raw}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setRaw(e.target.value.replace(/[^\d.,]/g, ''))}
            onClear={() => setRaw('')}
            placeholder={String(def.placeholder)}
          />
        </Field>
        {isBp && (
          <Field label={t('Нижнее')} className="flex-1">
            <Input
              inputMode="numeric"
              value={raw2}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setRaw2(e.target.value.replace(/[^\d]/g, ''))}
              onClear={() => setRaw2('')}
              placeholder={String(measureDef('bpDia').placeholder)}
            />
          </Field>
        )}
      </div>
      <Button className="w-full" disabled={!canSave} onClick={() => void save()}>
        {t('Сохранить')}
      </Button>
      {hasExisting && (
        <button
          type="button"
          onClick={() => void del()}
          className="flex w-full items-center justify-center rounded-2xl border border-lh-border-strong py-3 text-center font-medium text-danger active:opacity-70"
        >
          {t('Удалить замер за этот день')}
        </button>
      )}
    </div>
  );
}

function signed(n: number, decimals = 1): string {
  const abs = Math.abs(n).toFixed(decimals);
  // Разделитель по языку, как в formatMeasure.
  const s = getLang() === 'ru' ? abs.replace('.', ',') : abs;
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

function hours(h: number): string {
  // До минут округляется вся длительность, а не остаток отдельно: среднее
  // 6,995 ч давало «6 ч 60 м» вместо «7 ч».
  const total = Math.round(h * 60);
  const whole = Math.floor(total / 60);
  const min = total % 60;
  return min === 0 ? `${whole} ${t('ч')}` : `${whole} ${t('ч')} ${min} ${t('м')}`;
}

export { MEASURES };
