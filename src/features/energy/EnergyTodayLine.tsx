import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { todayKey } from '../../lib/dates';
import { t } from '../../lib/i18n';
import { ENERGY_LABEL, ENERGY_LEVELS, levelByDate } from '../../lib/energy';
import { useNavLayout } from '../../hooks/useNavLayout';
import { toggleEnergyLevel } from './energyRepo';
import type { EnergyLevel } from '../../db/types';

/** Шкала 1–5 одной строкой: отметка ставится одним тапом прямо с «Сегодня».
 *  Ежедневный ритуал выживает, только если он в один жест — переход в раздел
 *  ради отметки его бы убил.
 *
 *  Поэтому пока отметки НЕТ, шкала всегда здесь, во всю ширину.
 *
 *  Сворачивается она НЕ в момент тапа, а со следующего открытия экрана. Две
 *  причины, обе про руки: исчезнуть под пальцем сразу после нажатия — значит
 *  дёрнуть ленту в момент, когда человек ещё смотрит на неё; и снять
 *  ошибочную отметку повторным тапом по той же цифре (так это и работает)
 *  стало бы нельзя — пришлось бы сперва разворачивать. Поэтому свёрнутым
 *  экран встречает того, кто УЖЕ отметился раньше, а поставивший отметку
 *  сейчас видит шкалу до ухода с экрана.
 *
 *  `open` — раскрытие по тапу на ячейку полосы: изменить отметку можно в
 *  любой момент и снова одним тапом. */
export function EnergyTodayLine({ collapsed = false }: { collapsed?: boolean }) {
  const { hidden } = useNavLayout();
  const today = todayKey();
  const logs = useLiveQuery(() => db.energyLogs.toArray(), []);
  const current = levelByDate(alive(logs ?? [])).get(today) ?? null;


  // После хуков, не раньше: порядок хуков в React не может зависеть от условия.
  // Скрытый раздел молчит — выключивший «Энергию» не должен видеть ни строку
  // ввода, ни намёков на неё (то же правило, что у привычек в HabitsToday).
  if (hidden.includes('energy')) return null;
  // Свёрнуто — значит день отметили ДО открытия экрана и значение показывает
  // полоса; дублировать его здесь нечем. Решение принимает TodayPage по
  // снимку (useDayOpenSnapshot), чтобы полоса и блок не разошлись.
  if (collapsed && current != null) return null;

  return (
    <section className="mb-5">
      <h2 className="mb-2 flex items-center justify-between px-1 lh-section">
        <span>{t('Энергия')}</span>
        <span className="text-xs font-normal">
          {current ? t(ENERGY_LABEL[current]) : t('не отмечено')}
        </span>
      </h2>
      <div className="card flex items-center gap-1 px-2 py-2">
        {ENERGY_LEVELS.map((n) => {
          const active = current === n;
          return (
            <button
              key={n}
              type="button"
              aria-label={`${n} — ${t(ENERGY_LABEL[n])}`}
              aria-pressed={active}
              onClick={() => void toggleEnergyLevel(today, n as EnergyLevel, current)}
              className="flex h-11 flex-1 items-center justify-center active:opacity-70"
            >
              <span
                className={`flex size-9 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
                  active
                    ? 'bg-lh-accent text-lh-bg shadow-[0_2px_10px_-3px_var(--app-accent-fill)]'
                    : 'bg-lh-surface-2 text-lh-text-secondary'
                }`}
              >
                {n}
              </span>
            </button>
          );
        })}
      </div>
      {/* Якоря показываются, пока отметки нет: шкала должна мерить способность
          работать, а не настроение, иначе значения плывут от недели к неделе.
          После отметки подпись уровня уже стоит в заголовке — дубль убираем. */}
      {!current && (
        <p className="mt-1.5 px-1 text-2xs text-lh-text-secondary">
          {t('1 — еле держусь · 3 — рабочий режим · 5 — прёт')}
        </p>
      )}
    </section>
  );
}
