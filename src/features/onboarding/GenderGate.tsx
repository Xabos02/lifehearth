import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { UserRound } from 'lucide-react';
import { db } from '../../db/db';
import { updateSettings } from '../../hooks/useSettings';
import { ICON, STROKE_STRONG } from '../../components/ui/icons';
import { getLang, t } from '../../lib/i18n';

/**
 * Обязательный выбор пола при первом запуске — раньше вводного тура и всего
 * остального. От ответа зависит состав приложения: раздел «Женские дни»
 * существует только в женском профиле, у мужского его нет ни в навигации, ни
 * в настройках, ни по прямому адресу.
 *
 * Кнопки «Пропустить» нет намеренно: без ответа непонятно, какое приложение
 * показывать. Ошибка при выборе не фатальна — пол меняется в профиле, данные
 * скрытых разделов при смене не удаляются.
 *
 * У пользователей, поставивших приложение до появления этого экрана, поле
 * пусто — гейт покажется им один раз при первом запуске после обновления.
 */
export function GenderGate() {
  const settings = useLiveQuery(() => db.settings.get('app'), []);
  const [picked, setPicked] = useState<'female' | 'male' | null>(null);

  // Пока настройки не загружены — не мигаем гейтом; выбор сделан — гейта нет.
  if (!settings || settings.gender) return null;

  const OPTIONS = [
    { value: 'female' as const, label: t('Женский') },
    { value: 'male' as const, label: t('Мужской') },
  ];

  return (
    // z-[90] — выше тура (80) и окна о переустановке (85): у обновившегося
    // пользователя без выбранного пола этот экран обязан быть первым, что он
    // видит, а не третьим в очереди одноразовых окон.
    <div className="fixed inset-0 z-[90] flex flex-col bg-lh-bg">
      <div className="relative flex min-h-0 flex-1 animate-fade-in flex-col items-center justify-center gap-5 px-8 text-center">
        <div className="flex size-20 items-center justify-center rounded-3xl tile-lh text-lh-accent shadow-[var(--shadow-accent)]">
          <UserRound size={ICON.hero} strokeWidth={STROKE_STRONG} />
        </div>
        <h2 className="text-2xl font-extralight tracking-tight">{t('Ваш пол')}</h2>
        <p className="max-w-sm text-sm leading-relaxed text-lh-text-secondary">
          {t('От ответа зависит набор разделов: например, «Женские дни» — календарь цикла и самочувствия — есть только в женском профиле. Изменить выбор можно потом в профиле.')}
        </p>

        <div role="radiogroup" aria-label={t('Пол')} className="mt-2 flex w-full max-w-sm gap-3">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={picked === o.value}
              onClick={() => setPicked(o.value)}
              className={`flex-1 rounded-2xl border-2 px-4 py-5 font-semibold transition-colors ${
                picked === o.value
                  ? 'border-lh-accent bg-lh-accent-dim text-lh-accent'
                  : 'border-lh-border-strong bg-lh-surface'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative px-6 pb-[calc(env(safe-area-inset-bottom)+20px)]">
        <button
          type="button"
          disabled={picked === null}
          onClick={() => picked && void updateSettings({ gender: picked })}
          className="flex w-full items-center justify-center rounded-2xl bg-lh-accent px-5 py-3.5 font-semibold text-lh-bg shadow-[var(--shadow-accent)] active:opacity-80 disabled:opacity-40"
        >
          {/* Ключ «Продолжить» в словаре занят таймером ('Resume') — здесь смысл
              «дальше», а не «возобновить», поэтому английская ветка явная. */}
          {getLang() === 'en' ? 'Continue' : 'Продолжить'}
        </button>
      </div>
    </div>
  );
}
