import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { Sheet } from '../../components/ui/Sheet';
import { t } from '../../lib/i18n';
import { updateSettings, useSettings } from '../../hooks/useSettings';
import { WORKOUT_COLORS } from './workouts';

/** Цвет отметки тренировки — из кнопки «Цвет» под спорт-календарём. Выбор
 *  пишется сразу, шторка остаётся открытой: точки за ней перекрашиваются на
 *  глазах, можно сравнить. Выбор цвета молчит (PROTOCOL §6.4). Кружки — как
 *  выбор цвета проекта и привычки, но с названиями цветов для читалки. */
export function WorkoutColorSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const saved = useSettings().workoutColor;
  const current = (WORKOUT_COLORS.find((c) => c.value === saved) ?? WORKOUT_COLORS[0]).value;
  return (
    <Sheet open={open} onClose={onClose} title={t('Цвет отметки')}>
      <p className="mb-4 text-sm text-lh-text-secondary">
        {t('Так отмечается день с тренировкой — в календаре, в списке и на «Сегодня».')}
      </p>
      <div role="radiogroup" aria-label={t('Цвет отметки')} className="flex flex-wrap gap-2.5">
        {WORKOUT_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={c.value === current}
            aria-label={t(c.label)}
            onClick={() => void updateSettings({ workoutColor: c.value })}
            className={`size-9 rounded-full border-2 transition-colors ${HIT_SLOP_44} ${
              c.value === current ? 'border-lh-text-primary' : 'border-transparent'
            }`}
            style={{ background: c.color }}
          />
        ))}
      </div>
    </Sheet>
  );
}
