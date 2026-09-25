import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { listFamilyConfigs } from '../lib/family/familyState';
import { connectAllFamilies, disconnectAllFamilies, subscribeIncoming } from '../lib/family/familyChat';
import { armSoundUnlock, playMessageSound } from '../lib/sounds';
import { useConsent } from '../lib/consent';

/** Держит семейные WebSocket-соединения живыми (по одному на группу), пока
 *  приложение открыто и есть хотя бы одна включённая группа. Переподключается
 *  при возврате в приложение и появлении сети. connectAllFamilies идемпотентен:
 *  поднимает новые группы, снимает удалённые, по существующим — no-op. */
export function FamilyRunner() {
  // Звук нового сообщения при открытом приложении (закрытое покрывает пуш).
  useEffect(() => {
    armSoundUnlock();
    return subscribeIncoming(() => {
      if (document.visibilityState === 'visible') void playMessageSound();
    });
  }, []);

  // Сигнатура включённых групп — пересоздаём эффект при добавлении/выходе.
  const sig = useLiveQuery(async () => {
    const cfgs = await listFamilyConfigs();
    return cfgs
      .filter((c) => c.enabled)
      .map((c) => c.familyId)
      .sort()
      .join(',');
  }, []);

  // Без согласия — пауза: не подключаемся. disconnectAllFamilies здесь нельзя
  // — он чистит реестр движков, и подписки звонков и статуса остались бы на
  // старых экземплярах до перезагрузки.
  const consent = useConsent();

  useEffect(() => {
    if (sig === undefined) return; // ещё грузится
    if (!sig) {
      disconnectAllFamilies();
      return;
    }
    if (!consent) return;
    const wake = () => {
      if (document.visibilityState === 'visible') void connectAllFamilies();
    };
    void connectAllFamilies();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
  }, [sig, consent]);
  return null;
}
