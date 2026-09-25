import { useEffect, useState } from 'react';
import {
  Sun,
  Moon,
  CloudSun,
  CloudMoon,
  Cloud,
  CloudFog,
  CloudDrizzle,
  CloudRain,
  CloudSnow,
  CloudRainWind,
  CloudLightning,
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { todayKey } from '../../lib/dates';
import { ENERGY_LABEL, levelByDate } from '../../lib/energy';
import { useTodayHabits } from '../habits/useTodayHabits';
import { useNavLayout } from '../../hooks/useNavLayout';
import {
  // Те же знаки, что у разделов «Энергия» и «Привычки» в списке разделов:
  // ячейка полосы ведёт именно туда, и знак должен совпадать.
  GEnergy,
  GHabits,
} from '../../components/ui/glyphs';
import { getWeather, weatherLabel, type Weather } from '../../lib/weather';
import { ICON, STROKE_STRONG } from '../../components/ui/icons';
import { t } from '../../lib/i18n';
import { useConsent } from '../../lib/consent';

// Готовый элемент, а не тип компонента: динамический <Icon/> в рендере ловит
// eslint-правило react-hooks/static-components.
function weatherIcon(code: number, isDay: boolean) {
  const p = { size: ICON.header, strokeWidth: STROKE_STRONG };
  if (code === 0) return isDay ? <Sun {...p} /> : <Moon {...p} />;
  if (code <= 2) return isDay ? <CloudSun {...p} /> : <CloudMoon {...p} />;
  if (code === 3) return <Cloud {...p} />;
  if (code <= 48) return <CloudFog {...p} />;
  if (code <= 57) return <CloudDrizzle {...p} />;
  if (code <= 67) return <CloudRain {...p} />;
  if (code <= 77) return <CloudSnow {...p} />;
  if (code <= 82) return <CloudRainWind {...p} />;
  if (code <= 86) return <CloudSnow {...p} />;
  return <CloudLightning {...p} />;
}

/** Ячейка полосы: подпись сверху, значение снизу. Кликабельна только там,
 *  где есть что открыть — погода никуда не ведёт и кнопкой не притворяется. */
function Cell({
  icon,
  label,
  value,
  extra,
  wide = false,
  tight = false,
  onClick,
  ariaLabel,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  /** Ячейка погоды: ей нужно чуть больше места — три строки и самая длинная
   *  подпись («Малооблачно» против «Силы»). */
  wide?: boolean;
  /** Три ячейки в ряд: подпись идёт ступенью мельче, иначе «Малооблачно» и
   *  «Привычки» упираются в край и обрезаются многоточием. */
  tight?: boolean;
  /** Третья строка — только у погоды: прогноз на день, ради которого на неё и
   *  смотрят утром. Без неё полоса теряла бы то, что прежняя карточка давала. */
  extra?: string;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const inner = (
    <>
      <span className={`flex items-center gap-1.5 text-muted ${tight ? 'text-2xs' : 'text-xs'}`}>
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="mt-0.5 block truncate text-base font-semibold">{value}</span>
      {extra && <span className="mt-0.5 block truncate text-2xs text-muted">{extra}</span>}
    </>
  );
  // min-h-11: ячейка — зона касания, а не просто текст.
  const cls = `min-w-0 px-3 py-2 text-left min-h-11 ${wide ? 'flex-[1.25]' : 'flex-1'}`;
  return onClick ? (
    <button type="button" onClick={onClick} aria-label={ariaLabel} className={`${cls} active:bg-surface-2`}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

/**
 * Полоса дня: погода, силы и привычки одной строкой из ячеек.
 *
 * ЧТО ЗДЕСЬ ПОКАЗЫВАЕТСЯ, А ЧТО НЕТ. Полоса берёт на себя только то, что УЖЕ
 * СДЕЛАНО: отмеченный уровень сил и закрытый список привычек. Пока отметки
 * нет, шкала 1–5 остаётся отдельной строкой, а невыполненные привычки —
 * списком с галочками: и то, и другое ставится одним тапом прямо с «Сегодня»,
 * и прятать их в ячейку значило бы менять один жест на два. Ежедневный ритуал
 * этого не переживает (в EnergyTodayLine это записано прямым текстом).
 *
 * То есть утром экран выглядит как раньше — всё под рукой, — а по мере того
 * как дела закрываются, три блока сжимаются в одну строку и место уходит
 * задачам. Тап по ячейке возвращает развёрнутый вид: изменить отметку или
 * заглянуть в привычки можно в любой момент.
 *
 * Погода всегда живёт здесь: она ничего не требует, только сообщает.
 */
export function DayBand({
  showEnergy: wantEnergy,
  showHabits: wantHabits,
  onToggleEnergy,
  onToggleHabits,
}: {
  /** Показывать ячейку сил: решает TodayPage по снимку дня — ровно тогда,
   *  когда свёрнут блок со шкалой. Иначе значение видно дважды. */
  showEnergy: boolean;
  showHabits: boolean;
  onToggleEnergy: () => void;
  onToggleHabits: () => void;
}) {
  const [w, setW] = useState<Weather | null | 'loading'>('loading');
  // Погода — внешнее (Open-Meteo видит место до ~11 км и IP), выключателя у
  // неё нет: без согласия ячейки просто нет, после «Принимаю» она появляется
  // сама — эффект зависит от согласия.
  const consent = useConsent();
  const wv = consent ? w : null;
  const { hidden } = useNavLayout();
  const today = todayKey();
  const logs = useLiveQuery(() => db.energyLogs.toArray(), []);
  const energy = levelByDate(alive(logs ?? [])).get(today) ?? null;
  const { planned, doneCount, allDone } = useTodayHabits();

  useEffect(() => {
    if (!consent) return;
    let live = true;
    void getWeather().then((res) => {
      if (live) setW(res);
    });
    return () => {
      live = false;
    };
  }, [consent]);

  const showEnergy = wantEnergy && !hidden.includes('energy') && energy != null;
  const showHabits = wantHabits && !hidden.includes('habits') && allDone;
  const weather = wv !== 'loading' && wv ? wv : null;

  // На троих ячейках каждой достаётся треть экрана, и полные значения там
  // обрезаются многоточием — а обрезанное значение хуже краткого: «4 — Хорош…»
  // не читается вовсе. Поэтому при трёх ячейках значения короче: у сил цифра
  // отдельно от слова, у погоды остаётся прогноз без ощущаемой.
  const tight = [weather, showEnergy, showHabits].filter(Boolean).length >= 3;

  // Полоса без единой ячейки — это пустая карточка: не рисуем ничего.
  if (!weather && !showEnergy && !showHabits) {
    // Пока погода едет, держим место под неё — иначе лента дёргается, когда
    // ответ приходит (та же причина, что у прежней заглушки виджета).
    return wv === 'loading' ? <section className="card mb-4 h-[60px] animate-pulse" aria-hidden /> : null;
  }

  // ОДНА ЯЧЕЙКА — ОДНА СТРОКА. Пока силы не отмечены и привычки не закрыты, в
  // полосе стоит только погода, и три её столбика занимали левую треть,
  // оставляя справа пустоту. На всю ширину та же информация читается лучше:
  // температура крупно слева, прогноз прижат к правому краю. Как только
  // появляется вторая ячейка, обе возвращаются к столбикам — там ширина уже
  // поделена, и выравнивать нечего.
  if (weather && !showEnergy && !showHabits) {
    return (
      <section className="card mb-4 flex items-center gap-3 px-3.5 py-2.5" aria-label={t('Сегодня коротко')}>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl tile-accent text-accent">
          {weatherIcon(weather.code, weather.isDay)}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="text-2xl leading-none font-bold tracking-tight">{weather.tempC}°</span>
          <span className="truncate text-sm text-muted">{weatherLabel(weather.code)}</span>
        </span>
        <span className="shrink-0 text-right text-xs text-muted">
          <span className="block">{t('ощущается {feels}°', { feels: weather.feelsC })}</span>
          <span className="block tabular-nums">
            {t('↑{max}° ↓{min}°', { max: weather.maxC, min: weather.minC })}
          </span>
        </span>
      </section>
    );
  }

  return (
    <section className="card mb-4 flex items-stretch divide-x divide-hairline" aria-label={t('Сегодня коротко')}>
      {weather && (
        <Cell
          icon={weatherIcon(weather.code, weather.isDay)}
          label={weatherLabel(weather.code)}
          wide
          tight={tight}
          value={`${weather.tempC}°`}
          // Что показывать третьей строкой, зависит от того, сколько места
          // осталось. Сокращать до «как 22°» больше не пробуем: владелец
          // приложения прочитал это и спросил, что значит «как», — сокращение,
          // которое надо расшифровывать, хуже отсутствующей строки.
          // Три ячейки: только прогноз стрелками (↑ и ↓ читаются без подписи).
          // Две: ощущаемая словом — по ней решают, что надеть.
          extra={
            tight
              ? t('↑{max}° ↓{min}°', { max: weather.maxC, min: weather.minC })
              : t('ощущается {feels}°', { feels: weather.feelsC })
          }
        />
      )}
      {showEnergy && (
        <Cell
          icon={<GEnergy size={ICON.inline} />}
          tight={tight}
          label={t('Силы')}
          value={tight ? String(energy) : `${energy} — ${t(ENERGY_LABEL[energy])}`}
          extra={tight ? t(ENERGY_LABEL[energy]) : undefined}
          onClick={onToggleEnergy}
          ariaLabel={t('Изменить отметку сил')}
        />
      )}
      {showHabits && (
        <Cell
          icon={<GHabits size={ICON.inline} />}
          tight={tight}
          label={t('Привычки')}
          value={t('{done} из {total}', { done: doneCount, total: planned.length })}
          onClick={onToggleHabits}
          ariaLabel={t('Показать привычки')}
        />
      )}
    </section>
  );
}
