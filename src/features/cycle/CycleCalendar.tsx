import { useMemo } from 'react';
import {
  GChevronLeft as ChevronLeft,
  GChevronRight as ChevronRight,
} from '../../components/ui/glyphs';
import { HIT_SLOP_44 } from '../../components/ui/Checkbox';
import { addDaysKey, todayKey, WEEKDAY_LABELS } from '../../lib/dates';
import { getLang, t } from '../../lib/i18n';
import type { CycleData } from './useCycleData';
import { ICON } from '../../components/ui/icons';

/** Сетка месяца с отметками цикла.
 *
 *  Ни один статус не передаётся ТОЛЬКО цветом: у каждого есть форма или
 *  подпись. Цвет как единственный носитель информации не работает ни у
 *  дальтоников, ни в скринридере, ни на солнце — а этот экран смотрят на
 *  улице чаще, чем любой другой.
 *
 *  Прогнозные дни рисуются пунктиром, фактические — заливкой. Разница между
 *  «это было» и «это ожидается» — самая важная в разделе: спутав их, человек
 *  решит, что приложение записало то, чего не было. */

interface Props {
  data: CycleData;
  month: string; // 'YYYY-MM-01'
  onMonth: (next: string) => void;
  onPick: (date: string) => void;
}

const BLEEDING_DOTS: Record<string, number> = { spotting: 1, light: 1, medium: 2, heavy: 3 };

function monthLabel(month: string): string {
  const d = new Date(month + 'T00:00:00Z');
  const locale = getLang() === 'en' ? 'en-US' : 'ru-RU';
  const name = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(d);
  return name.charAt(0).toUpperCase() + name.slice(1) + ' ' + d.getUTCFullYear();
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

export function CycleCalendar({ data, month, onMonth, onPick }: Props) {
  const today = todayKey();

  const grid = useMemo(() => {
    const first = new Date(month + 'T00:00:00Z');
    const daysInMonth = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    ).getUTCDate();
    // Понедельник — первый день недели: WEEKDAY_LABELS начинается с «Пн».
    const lead = (first.getUTCDay() + 6) % 7;
    const cells: (string | null)[] = new Array(lead).fill(null);
    for (let i = 0; i < daysInMonth; i++) cells.push(addDaysKey(month, i));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [month]);

  const { prediction, settings } = data;
  const inPredictedWindow = (date: string): boolean =>
    prediction.lo80 !== undefined &&
    prediction.hi80 !== undefined &&
    date >= prediction.lo80 &&
    date <= prediction.hi80 &&
    date > today;

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        {/* Кегль ужимается только на узких экранах: «Сентябрь 2026» при 19px
            требует больше места, чем остаётся рядом со стрелками. */}
        <h2 className="min-w-0 truncate text-lg font-semibold">
          {monthLabel(month)}
        </h2>
        {/* pr-1.5: невидимая зона касания стрелки на 5,6px шире самой кнопки,
            а .card обрезает всё, что вылезло за него, — без этого отступа
            правая часть зоны у последней стрелки просто пропадала. */}
        <div className="flex shrink-0 items-center gap-2 pr-1.5">
          <button
            type="button"
            onClick={() => onMonth(shiftMonth(month, -1))}
            aria-label={t('Предыдущий месяц')}
            className={`shrink-0 rounded-lg p-1.5 text-muted active:opacity-60 ${HIT_SLOP_44}`}
          >
            <ChevronLeft size={ICON.header} />
          </button>
          {/* ml-1 поверх gap-2: зона касания 44px вылезает за кнопку на 5,6px с
              каждой стороны, значит между стрелками нужно не меньше 11,25px,
              иначе тап у края уйдёт соседней и месяц перелистнётся не туда. */}
          <button
            type="button"
            onClick={() => onMonth(shiftMonth(month, 1))}
            aria-label={t('Следующий месяц')}
            className={`ml-1 shrink-0 rounded-lg p-1.5 text-muted active:opacity-60 ${HIT_SLOP_44}`}
          >
            <ChevronRight size={ICON.header} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {WEEKDAY_LABELS.map((l) => (
          <div key={l} className="pb-1 text-center text-2xs font-medium text-muted">
            {t(l)}
          </div>
        ))}

        {grid.map((date, i) => {
          if (date === null) return <div key={`gap-${i}`} />;
          const log = data.dayByDate.get(date);
          const dots = log?.bleeding ? (BLEEDING_DOTS[log.bleeding] ?? 0) : 0;
          const isSpotting = log?.bleeding === 'spotting';
          const isToday = date === today;
          const predicted = inPredictedWindow(date);
          const fertileP = settings.fertilityDisplay !== 'off' ? (data.fertile.get(date) ?? 0) : 0;
          const hasSymptoms = (log?.symptomKeys?.length ?? 0) > 0;

          // Подпись для скринридера собирается словами: точки и пунктир для
          // него не существуют.
          const label = [
            t('{d} число', { d: new Date(date + 'T00:00:00Z').getUTCDate() }),
            dots > 0 && !isSpotting ? t('менструация') : null,
            isSpotting ? t('мажущие выделения') : null,
            predicted ? t('ожидается менструация') : null,
            fertileP > 0.15 ? t('вероятны фертильные дни') : null,
            hasSymptoms ? t('есть отметки') : null,
          ]
            .filter(Boolean)
            .join(', ');

          return (
            <button
              key={date}
              type="button"
              // Будущий день не отмечается: отметка «на 18-е» закрывала текущий
              // цикл и заводила новый со стартом в будущем, ломая прогноз.
              disabled={date > today}
              onClick={() => onPick(date)}
              aria-label={date > today ? `${label}${t(', ещё не наступил')}` : label}
              aria-current={isToday ? 'date' : undefined}
              // Высота вместо aspect-square: в семи колонках на 320px ячейка
              // выходит 32px в ширину, и квадрат делал бы её 32px и в высоту.
              // Ширину не отвоевать — колонок ровно семь, — но высоту дать
              // можно: 46,75px закрывают минимальный тач-таргет хотя бы по
              // одной оси. Промах по соседнему дню не разрушителен: открывается
              // другой день, а не удаляется запись.
              className={`relative flex min-h-11 flex-col items-center justify-center rounded-xl py-1 text-sm transition-colors active:opacity-70 ${
                dots > 0 && !isSpotting
                  ? 'bg-danger/15 font-semibold text-danger'
                  : isToday
                    ? 'bg-accent/15 font-semibold text-accent'
                    : 'text-text'
              } ${predicted ? 'border border-dashed border-danger/50' : ''}`}
            >
              {/* Фертильность — тонкая полоса сверху, а не заливка ячейки:
                  заливкой она конкурировала бы с фактом менструации, а факт
                  всегда важнее оценки. Прозрачность отражает вероятность. */}
              {fertileP > 0.05 && (
                <span
                  aria-hidden
                  className="absolute inset-x-2 top-1 h-0.5 rounded-full bg-success"
                  style={{ opacity: Math.min(1, 0.25 + fertileP) }}
                />
              )}
              <span className="leading-none">
                {new Date(date + 'T00:00:00Z').getUTCDate()}
              </span>
              {/* Обильность — числом точек, а не оттенком: оттенки на глаз не
                  различаются, а три точки от одной отличаются всегда. */}
              <span aria-hidden className="mt-0.5 flex h-1 items-center gap-0.5">
                {isSpotting ? (
                  <span className="size-1 rounded-full border border-danger/70" />
                ) : (
                  Array.from({ length: dots }, (_, k) => (
                    <span key={k} className="size-1 rounded-full bg-danger" />
                  ))
                )}
                {hasSymptoms && dots === 0 && <span className="size-1 rounded-full bg-muted" />}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-muted">
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-danger" /> {t('менструация')}
        </span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full border border-danger/70" /> {t('мазня')}
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2.5 rounded border border-dashed border-danger/50" /> {t('ожидается')}
        </span>
        {settings.fertilityDisplay !== 'off' && (
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-3 rounded-full bg-success" /> {t('фертильные дни')}
          </span>
        )}
      </div>
    </div>
  );
}
