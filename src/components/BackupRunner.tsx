import { useEffect } from 'react';
import { db } from '../db/db';
import { now } from '../db/repo';
import { updateSettings } from '../hooks/useSettings';
import { getSyncConfig } from '../lib/syncState';
import { BackupWouldLoseDataError, pushAccountSnapshot } from '../lib/cloudBackup';
import { shouldBackupNow } from '../lib/backupSchedule';
import { hasConsent, useConsent } from '../lib/consent';

const CHECK_MS = 5 * 60_000; // сверяемся раз в 5 минут (пока приложение открыто)

// Курсор времени в модуле: не спамим БД проверками между тиками одной сессии.
let inFlight = false;

async function maybeBackup(): Promise<void> {
  // Без согласия — пауза, и здесь, а не только в pushAccountSnapshot: иначе
  // тихий отказ записался бы как сделанная копия (lastCloudBackupAt).
  if (inFlight || !hasConsent()) return;
  const s = await db.settings.get('app');
  if (!s || s.autoBackup !== 'cloud') return;
  const c = await getSyncConfig();
  if (!c?.enabled) return; // облачная копия — только при включённой синхронизации
  if (!shouldBackupNow(s, Date.now())) return;
  inFlight = true;
  try {
    await pushAccountSnapshot();
    await updateSettings({ lastCloudBackupAt: now(), cloudBackupBlocked: null, cloudBackupFailedAt: null });
  } catch (e) {
    // Автокопия НИКОГДА не перезаписывает копию, которая полнее нашей: у
    // фонового процесса нет способа спросить, а молча стереть чужую историю
    // цикла и переписку он не вправе. Оставляем след, чтобы настройки могли
    // показать это человеку — иначе автокопия просто «не работает» без
    // объяснений.
    // Отметку о неудаче ставим в любом случае: следующая попытка — через час,
    // а не через пять минут. Экран настроек по ней же показывает, что копия
    // не делается, — иначе автокопия могла месяцами молча не работать.
    await updateSettings({
      cloudBackupFailedAt: now(),
      ...(e instanceof BackupWouldLoseDataError ? { cloudBackupBlocked: now() } : {}),
    });
    if (!(e instanceof BackupWouldLoseDataError)) throw e;
  } finally {
    inFlight = false;
  }
}

/** Периодически кладёт зашифрованный снапшот аккаунта в облако, если включена
 *  авто-копия. Тихо выходит, когда выключено или синхронизация не настроена. */
export function BackupRunner() {
  // «Принимаю» — тоже повод проверить копию: без него она ждала бы возврата
  // в приложение или пяти минут.
  const consent = useConsent();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void maybeBackup().catch(() => {});
    };
    tick();
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    const id = setInterval(tick, CHECK_MS);
    return () => {
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
      clearInterval(id);
    };
  }, [consent]);
  return null;
}
