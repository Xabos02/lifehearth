import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { verifyPin } from '../../lib/crypto';
import type { CycleSettings } from '../../db/cycleTypes';
import { unlockCycleSection } from './lockState';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import {
  GLock as Lock,
} from '../../components/ui/glyphs';

/** Экран ввода кода перед разделом.
 *
 *  Разблокировка держится в памяти модуля, а не в хранилище: перезагрузка
 *  страницы снова закрывает раздел. Писать «разблокировано» в localStorage
 *  значило бы, что замок переживает закрытие приложения и не защищает ровно в
 *  тот момент, ради которого заводился.
 *
 *  Честная граница: код закрывает раздел от чужих глаз, но не шифрует данные.
 *  Тот, кто добрался до устройства и умеет открыть хранилище браузера,
 *  прочитает записи мимо этого экрана. Шифрование ключом из кода было бы
 *  сильнее, но забытый код означал бы безвозвратную потерю истории — а данные
 *  раздела существуют в одном экземпляре. Об этом прямо сказано в настройках. */

/** Задержка после неверной попытки. Растёт, чтобы подбор четырёхзначного кода
 *  перестал быть делом одной минуты, но не наказывал за одну опечатку. */
function delayFor(attempts: number): number {
  if (attempts < 3) return 0;
  return Math.min(30, 2 ** (attempts - 2)) * 1000;
}

export function CycleLock({
  settings,
  onUnlock,
}: {
  settings: CycleSettings;
  onUnlock: () => void;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  // Тикаем только пока идёт задержка: постоянный таймер на экране, который
  // почти всегда простаивает, — лишние перерисовки на ровном месте.
  useEffect(() => {
    if (waitUntil <= now) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [waitUntil, now]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const left = Math.max(0, Math.ceil((waitUntil - now) / 1000));

  async function check() {
    if (left > 0 || !settings.pin) return;
    const ok = await verifyPin(pin, settings.pin);
    if (ok) {
      unlockCycleSection();
      onUnlock();
      return;
    }
    const next = attempts + 1;
    setAttempts(next);
    setPin('');
    const delay = delayFor(next);
    if (delay > 0) setWaitUntil(Date.now() + delay);
    setNow(Date.now());
    setError(t('Неверный код. Попробуйте ещё раз'));
  }

  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-surface-2 text-muted">
        <Lock size={ICON.accent} />
      </span>
      <div>
        <p className="text-lg font-semibold">{t('Раздел закрыт')}</p>
        <p className="mt-1 text-sm text-muted">{t('Введи код, чтобы открыть.')}</p>
      </div>

      <div className="w-full max-w-56">
        <Input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, '').slice(0, 8));
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void check();
          }}
          className="text-center text-2xl tracking-[0.4em]"
          aria-label={t('Код доступа')}
          aria-invalid={error !== null}
        />
      </div>

      {/* Пока идёт пауза — живой отсчёт вместо ошибки, а не вдобавок к ней.
          Было: к застывшему «Подождите 2 с» дописывалось « — подождите 2 с»,
          а после паузы застывшее так и висело. Показ держится на паузе
          (left), а не на ошибке: ввод гасит ошибку, и начатый во время паузы
          код прятал отсчёт — «Открыть» оставалась серой без объяснения. */}
      {(left > 0 || error) && (
        <p className="text-sm text-danger" role="alert">
          {left > 0 ? t('Неверный код. Подождите {s}\u00A0с', { s: left }) : error}
        </p>
      )}

      <Button onClick={() => void check()} disabled={pin.length < 4 || left > 0} className="w-full max-w-56">
        {t('Открыть')}
      </Button>
    </div>
  );
}
