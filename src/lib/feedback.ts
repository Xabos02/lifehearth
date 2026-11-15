import { useSyncExternalStore } from 'react';

// Отклик на касания (PROTOCOL §6.4, канва design/tap-feedback, выбран А).
//
// Один выключатель — «Настройки → Отклик на касания» (settings.tapFeedback) —
// глушит всё разом: тактильный щелчок на iPhone (components/ui/Haptic.tsx),
// вибрацию Android (buzz) и щелчок барабанов (features/health/tick.ts).
//
// Флаг живёт в модуле, а не читается из базы: отклик обязан уйти в тот же миг,
// что и касание, а Dexie отвечает только асинхронно. main.tsx ставит флаг до
// первого рендера, watchFeedback держит его в ладу с базой — тот же приём, что
// у согласия (lib/consent.ts), только в обе стороны.

let on = true;
const subs = new Set<() => void>();

export function feedbackOn(): boolean {
  return on;
}

export function setFeedbackOn(v: boolean): void {
  if (on === v) return;
  on = v;
  for (const cb of subs) cb();
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** Для компонентов: накладка Haptic пропадает сразу, как отклик выключили. */
export function useFeedbackOn(): boolean {
  return useSyncExternalStore(subscribe, feedbackOn);
}

/** Флаг следит за базой: выключатель, вторая вкладка, восстановление из копии. */
export async function watchFeedback(): Promise<void> {
  const [{ liveQuery }, { db }] = await Promise.all([import('dexie'), import('../db/db')]);
  liveQuery(() => db.settings.get('app')).subscribe({
    next: (s) => setFeedbackOn(s?.tapFeedback !== false),
    error: () => {},
  });
}

/** Короткая вибрация — только Android: на iPhone Vibration API нет, и вызов
 *  там ничего не делает. Зовётся в момент самого действия: захват после
 *  удержания, отпускание на новом месте, порог свайпа, тап по накладке Haptic.
 *
 *  До первого касания Chromium вибрацию блокирует и пишет об этом в консоль
 *  (удержание сразу после загрузки страницы) — поэтому проверка активации. */
export function buzz(ms = 10): void {
  if (!on) return;
  try {
    const nav = navigator as Navigator & { userActivation?: { hasBeenActive: boolean } };
    if (nav.userActivation && !nav.userActivation.hasBeenActive) return;
    nav.vibrate?.(ms);
  } catch {
    /* нет API */
  }
}
