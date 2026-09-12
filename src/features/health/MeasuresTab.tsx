import { useMemo, useState, type ChangeEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { format } from 'date-fns';
import { db } from '../../db/db';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { t } from '../../lib/i18n';
import { dateLocale, fromKey, todayKey } from '../../lib/dates';
import type { MetricLog } from '../../db/types';
import { MEASURES, formatMeasure, logMeasure, measureDef, measureTrend, type MeasureKey, type MeasureDef } from './measures';

/** Вкладка «Здоровье»: четыре замера с трендом за 30 дней. Дневник, не
 *  диагностика: числа и линия, без выводов. Давление — две метрики в одной
 *  карточке: верхнее и нижнее вводятся вместе, показываются через дробь. */
export function MeasuresTab() {
  const today = todayKey();
  const logs = useLiveQuery(() => db.metricLogs.toArray(), []);
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

  return (
    <div className="space-y-4">
      <MeasureCard
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
        def={measureDef('sleep')}
        value={sleep.avg7 !== null ? hours(sleep.avg7) : null}
        unitOverride=""
        sub={
          sleep.last
            ? t('среднее за неделю · последний {when}: {v}', {
                when: format(fromKey(sleep.last.date), 'd MMM', { locale: dateLocale() }),
                v: hours(sleep.last.value),
              })
            : t('Замеров пока нет')
        }
        series={sleep.series.map((p) => p.value)}
        onAdd={() => setEditing('sleep')}
      />
      <MeasureCard
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
        def={{ ...measureDef('bpSys'), title: t('Давление') }}
        value={sys.last && dia.last ? `${Math.round(sys.last.value)} / ${Math.round(dia.last.value)}` : null}
        sub={sys.last ? format(fromKey(sys.last.date), 'd MMMM', { locale: dateLocale() }) : t('Замеров пока нет')}
        series={sys.series.map((p) => p.value)}
        onAdd={() => setEditing('bpSys')}
      />
      <p className="px-1 text-xs leading-snug text-muted">
        {t('Замеры вводятся руками: Apple Health веб-приложению закрыт. Второй замер за день заменяет первый.')}
      </p>

      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing ? t(editing === 'bpSys' ? 'Давление' : measureDef(editing).title) : ''}>
        {editing && <MeasureForm key={editing} measure={editing} onClose={() => setEditing(null)} />}
      </Sheet>
    </div>
  );
}

function MeasureCard({
  def,
  value,
  unitOverride,
  sub,
  series,
  onAdd,
}: {
  def: MeasureDef;
  value: string | null;
  unitOverride?: string;
  sub: string;
  series: number[];
  onAdd: () => void;
}) {
  const unit = unitOverride ?? def.unit;
  return (
    <section className="card p-4" data-testid={`measure-${def.key}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-muted">{t(def.title)}</h2>
          <p className="mt-0.5 text-2xl font-bold leading-tight tabular-nums">
            {value ?? '—'}
            {value && unit ? <span className="ml-1 text-sm font-medium text-muted">{t(unit)}</span> : null}
          </p>
          <p className="mt-0.5 text-xs text-muted">{sub}</p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className={`shrink-0 rounded-full border border-border px-3.5 py-1.5 text-sm font-medium text-accent active:opacity-60 ${HIT_SLOP_44}`}
        >
          {t('+ замер')}
        </button>
      </div>
      {series.length >= 2 && <Sparkline values={series} color={def.color} />}
    </section>
  );
}

/** Линия тренда без осей: достаточно увидеть направление. */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 300},${34 - ((v - min) / span) * 30}`)
    .join(' ');
  return (
    <svg viewBox="0 0 300 36" preserveAspectRatio="none" className="mt-2 h-9 w-full" aria-hidden>
      <polyline fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={pts} />
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
    raw !== '' && okRange(v1, def) && (!isBp || (raw2 !== '' && okRange(v2, measureDef('bpDia')))) && day <= todayKey();

  const save = async () => {
    await logMeasure(measure, day, Math.round(v1 / def.step) * def.step);
    if (isBp) await logMeasure('bpDia', day, Math.round(v2));
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
    </div>
  );
}

function signed(n: number, decimals = 1): string {
  const s = Math.abs(n).toFixed(decimals).replace('.', ',');
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

function hours(h: number): string {
  const whole = Math.floor(h);
  const min = Math.round((h - whole) * 60);
  return min === 0 ? `${whole} ${t('ч')}` : `${whole} ${t('ч')} ${min} ${t('м')}`;
}

export { MEASURES };
