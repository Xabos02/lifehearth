import { useState } from 'react';
import { Link } from 'react-router';
import { ShieldCheck } from 'lucide-react';
import {
  GChevronRight as ChevronRight,
  GClose as X,
} from '../../components/ui/glyphs';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import { pushEnabled } from '../../lib/push';
import { HIT_SLOP_44_POSITIONED } from '../../components/ui/hitSlop';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

// «Скрыть» — до следующего запуска, поэтому в памяти модуля, а не в состоянии
// строки: то жило, пока открыта «Сегодня», и строка возвращалась после первой
// же смены вкладки (прогон 13–17.09). Модуль живёт до перезагрузки страницы —
// ровно столько, сколько обещано; так же устроены подсказки «скрыть пока»
// (useHint).
let hiddenThisLaunch = false;

/**
 * Мягкое напоминание на «Сегодня»: защитить данные — включить синхронизацию,
 * облачную копию и уведомления. Показывается, пока и синхронизация, и
 * уведомления не включены; исчезает сама, когда оба включены. «Скрыть» скрывает
 * до следующего запуска (несознательно навсегда не прячем).
 *
 * Не включаем ничего по умолчанию намеренно: ключ шифрования нужно осознанно
 * сохранить, а разрешение на уведомления система запрашивает явным жестом —
 * поэтому строка ведёт в Настройки, где каждый шаг делается сознательно.
 *
 * СТРОКА, А НЕ КАРТОЧКА. Раньше здесь стоял блок с заголовком, тремя строками
 * объяснения и отдельной ссылкой — 237px, треть экрана «Сегодня», на котором
 * задачи дня и без того начинались за вторым экраном прокрутки. Служебная
 * просьба, одинаковая на каждом заходе, не может стоить дороже содержимого:
 * теперь это 48px (на телефоне текст ложится в две строки — 64px) —
 * состояние словом и переход. Объяснение никуда не делось,
 * оно на странице, куда ведёт переход.
 */
export function ProtectDataCard() {
  // Нормализуем к null: без этого «нет записи» (undefined) неотличимо от
  // «ещё грузится» (тоже undefined) — и карточка пряталась бы именно когда
  // синхронизации нет, то есть когда она нужнее всего.
  const syncCfg = useLiveQuery(() => db.sync.get('config').then((c) => c ?? null), []);
  const [dismissed, setDismissed] = useState(hiddenThisLaunch);
  // pushEnabled() синхронный; для карточки достаточно значения на монтировании.
  const [pushOn] = useState(() => pushEnabled());
  const syncOn = Boolean(syncCfg?.enabled);

  if (dismissed) return null;
  if (syncCfg === undefined) return null; // ещё грузится — не мигаем
  if (syncOn && pushOn) return null; // всё под защитой — не мозолим глаз

  // Состояние словом: что не защищено прямо сейчас. Длинное объяснение
  // («зашифрованная копия», «даже при закрытом приложении») переехало на
  // страницу настроек — в строке для него нет места, а на экране «Сегодня»
  // ему не место и подавно.
  const text = !syncOn
    ? t('Нет синхронизации и облачной копии')
    : t('Напоминания не придут при закрытом приложении');

  return (
    <section className="mb-5">
      <div className="card flex items-center gap-2.5 p-3">
        <ShieldCheck size={ICON.base} className="shrink-0 text-accent" />
        {/* Две строки, а не truncate: на ширине телефона под текст остаётся
            ~140px, и «Данные только на этом устройстве» обрезалось до
            «Данные только н…» — строка переставала что-либо сообщать. */}
        <p className="min-w-0 flex-1 line-clamp-2 text-sm leading-snug">{text}</p>
        <Link
          to="/more/settings"
          className="flex min-h-11 shrink-0 items-center gap-0.5 pl-1 text-sm font-semibold text-accent active:opacity-70"
        >
          {t('Настроить')}
          <ChevronRight size={ICON.action} />
        </Link>
        <button
          type="button"
          aria-label={t('Скрыть')}
          onClick={() => {
            hiddenThisLaunch = true;
            setDismissed(true);
          }}
          className={`relative flex size-7 shrink-0 items-center justify-center rounded-full text-muted active:opacity-60 ${HIT_SLOP_44_POSITIONED}`}
        >
          <X size={ICON.action} />
        </button>
      </div>
    </section>
  );
}
