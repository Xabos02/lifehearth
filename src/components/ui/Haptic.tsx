/**
 * Тактильный отклик на нажатие: кладётся последним ребёнком в кнопку.
 *
 * Android — Vibration API. На iPhone её нет (Safari не реализует), но у
 * системного переключателя `<input type="checkbox" switch>` есть родной
 * тактильный щелчок (Safari 18+). Программный `label.click()` Apple закрыла в
 * iOS 26.5, поэтому палец должен попасть по самому `<label>`: прозрачный
 * label лежит поверх кнопки и пересылает настоящий тап в спрятанный
 * переключатель. Клик по label всплывает в кнопку как обычно, а клик
 * переключателя дальше не идёт — обработчик кнопки срабатывает один раз.
 *
 * Размер — не меньше 44×44, как невидимая зона HIT_SLOP_44. Сам `::after`
 * этой зоны лежит поверх label и перехватил бы тап на всей площади, поэтому
 * index.css у кнопки с label гасит ему pointer-events и заодно ставит ей
 * `relative` (правило в @layer base — `absolute` из утилит его бьёт).
 * Приём — как у ios-haptics 3.3 (MIT); на устройстве не проверено.
 */
export function Haptic() {
  return (
    <label
      aria-hidden="true"
      data-haptic=""
      onClick={() => navigator.vibrate?.(10)}
      className="absolute top-1/2 left-1/2 h-[max(100%,44px)] w-[max(100%,44px)] -translate-x-1/2 -translate-y-1/2 touch-manipulation"
    >
      <input
        type="checkbox"
        tabIndex={-1}
        // `switch` нет в типах React — атрибут передаётся строкой через spread.
        {...{ switch: '' }}
        onClick={(e) => e.stopPropagation()}
        className="invisible absolute size-px"
      />
    </label>
  );
}
