import { t } from '../../lib/i18n';

/**
 * Переключатель «включено / выключено».
 *
 *  Появился там, где раньше стоял выбор из двух сегментов («Скрыт / Показать»,
 *  «Выкл / Вкл»): это не выбор варианта, а одно состояние, и тумблер читается
 *  быстрее — по положению, без чтения подписей. Заодно он занимает 44px вместо
 *  115px сегментов, а на строке настройки ширина дорога.
 *
 *  Доступность: role="switch" + aria-checked — скринридер объявляет «включено»
 *  или «выключено», а не «кнопка». Зона касания 44px по высоте держится
 *  padding'ом, сам тумблер меньше — как в системных переключателях.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Что именно переключается — уходит в aria-label. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${label}: ${checked ? t('включено') : t('выключено')}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex h-11 shrink-0 items-center px-1 disabled:opacity-40 ${
        disabled ? '' : 'active:opacity-70'
      }`}
    >
      <span
        className={`flex h-[26px] w-11 items-center rounded-full p-[3px] transition-colors duration-200 motion-reduce:transition-none ${
          checked ? 'bg-lh-accent' : 'bg-lh-border-strong'
        }`}
      >
        <span
          className={`size-5 rounded-full bg-white shadow-sm transition-transform duration-200 motion-reduce:transition-none ${
            checked ? 'translate-x-[18px]' : ''
          }`}
        />
      </span>
    </button>
  );
}
