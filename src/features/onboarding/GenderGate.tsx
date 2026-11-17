import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Flame, Mars, Venus } from 'lucide-react';
import { db } from '../../db/db';
import { updateSettings } from '../../hooks/useSettings';
import { ICON, STROKE_HEAVY, STROKE_STRONG } from '../../components/ui/icons';
import { GCheck, GLock } from '../../components/ui/glyphs';
import { Haptic } from '../../components/ui/Haptic';
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
    { value: 'female' as const, label: t('Женский'), hint: t('Включает раздел «Женские дни»'), Icon: Venus },
    { value: 'male' as const, label: t('Мужской'), hint: t('Все основные разделы'), Icon: Mars },
  ];

  return (
    // z-[90] — выше тура (80) и окна о переустановке (85): у обновившегося
    // пользователя без выбранного пола этот экран обязан быть первым, что он
    // видит, а не третьим в очереди одноразовых окон.
    <div className="fixed inset-0 z-[90] flex flex-col overflow-y-auto bg-lh-bg">
      <div className="mx-auto flex w-full max-w-md flex-1 animate-fade-in flex-col px-6 pt-[calc(env(safe-area-inset-top)+clamp(24px,6vh,64px))]">
        <div aria-hidden className="flex size-14 items-center justify-center rounded-2xl border border-lh-border bg-lh-surface text-lh-accent">
          <Flame size={ICON.accent} strokeWidth={STROKE_STRONG} />
        </div>
        <p className="mt-[clamp(16px,3vh,32px)] text-sm text-lh-text-secondary">{t('Перед началом')}</p>
        <h2 className="mt-1.5 text-[34px] font-extralight leading-[1.1] tracking-[-.8px]">{t('Ваш пол')}</h2>
        <p className="mt-3 text-base leading-normal text-lh-text-secondary">
          {t('От ответа зависит набор разделов: например, «Женские дни». Поменять можно в профиле.')}
        </p>

        <div role="radiogroup" aria-label={t('Пол')} className="mt-[clamp(20px,4vh,40px)] space-y-3">
          {OPTIONS.map((o) => {
            const sel = picked === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={sel}
                onClick={() => setPicked(o.value)}
                className={`flex min-h-[76px] w-full items-center gap-4 rounded-2xl border px-5 py-3 text-left transition-colors ${
                  sel ? 'border-lh-accent bg-lh-accent-dim' : 'border-lh-border bg-lh-surface'
                }`}
              >
                <span
                  aria-hidden
                  className={`flex size-11 shrink-0 items-center justify-center rounded-full ${
                    sel ? 'bg-lh-accent-dim text-lh-accent' : 'bg-lh-surface-2 text-lh-text-secondary'
                  }`}
                >
                  <o.Icon size={ICON.base} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-base ${sel ? 'font-semibold' : ''}`}>{o.label}</span>
                  {/* Серого на золотой подложке нет (PROTOCOL §1.2): у выбранной
                      карточки подсказка основным цветом — 12.3 в светлой и 13.9
                      в тёмной; серый давал 4.36 и 4.69. */}
                  <span className={`mt-0.5 block text-sm ${sel ? 'text-lh-text-primary' : 'text-lh-text-secondary'}`}>{o.hint}</span>
                </span>
                <span
                  aria-hidden
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full ${
                    sel ? 'bg-lh-accent text-lh-bg' : 'border-2 border-lh-border-strong'
                  }`}
                >
                  {sel && <GCheck size={ICON.inline} strokeWidth={STROKE_HEAVY} />}
                </span>
                {/* Радио щёлкает (PROTOCOL §6.4); выбранный вариант — нет. */}
                <Haptic off={sel} />
              </button>
            );
          })}
        </div>

        <div className="mt-auto pb-[calc(env(safe-area-inset-bottom)+24px)] pt-6">
          <div className="mb-5 flex gap-2.5 px-1">
            <GLock aria-hidden size={ICON.inline} className="mt-[2px] shrink-0 text-lh-text-secondary" />
            {/* Настройки устройства не синхронизируются (sync.ts). Обещание
                ровно такое — не шире: про резервные копии здесь не говорим. */}
            <p className="text-sm leading-[1.45] text-lh-text-secondary">
              {t('Ответ хранится на этом устройстве и не синхронизируется.')}
            </p>
          </div>
          <button
            type="button"
            disabled={picked === null}
            onClick={() => picked && void updateSettings({ gender: picked })}
            className="flex h-[52px] w-full items-center justify-center rounded-xl bg-lh-accent text-base font-semibold text-lh-bg active:opacity-80 disabled:opacity-40"
          >
            {/* Ключ «Продолжить» в словаре занят таймером ('Resume') — здесь смысл
                «дальше», а не «возобновить», поэтому английская ветка явная. */}
            {getLang() === 'en' ? 'Continue' : 'Продолжить'}
          </button>
        </div>
      </div>
    </div>
  );
}
