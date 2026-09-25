import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { flushSyncNow, runSync } from '../lib/sync';
import { kickSyncLive, startSyncLive, stopSyncLive } from '../lib/syncLive';
import { ensurePushRegistered, retryPendingReminders } from '../lib/push';
import { useConsent } from '../lib/consent';
import { getSyncConfig } from '../lib/syncState';
import { db } from '../db/db';

// Опрос раз в минуту — запасной путь. Основной — живой сигнал сервера о
// чужой правке (lib/syncLive.ts): он приходит через секунды. Опрос ловит то,
// что сигнал пропустил (сокет был оборван, сервер не смог разбудить).
const INTERVAL_MS = 60_000;

/** Запускает синхронизацию при старте, возврате в приложение, появлении сети
 *  и периодически; держит живое соединение для сигнала о чужих правках.
 *  runSync сам выходит, если синк не настроен/выключен (или уже идёт). */
export function SyncRunner() {
  // Живое соединение живёт ровно столько, сколько включён обмен: включили в
  // настройках — поднимается, отключили или сменили аккаунт — закрывается.
  const account = useLiveQuery(async () => {
    const c = await getSyncConfig();
    return c?.enabled ? c.accountId : null;
  }, []);
  // Без согласия на внешнее (задача 34) — пауза: ни сокета, ни опроса, ни
  // повтора напоминаний. Конфиг и ключ не трогаем; «Принимаю» перезапускает
  // эффекты, и обмен догоняет всё по курсорам.
  const consent = useConsent();

  useEffect(() => {
    if (!account || !consent) return;
    startSyncLive();
    return () => stopSyncLive();
  }, [account, consent]);

  useEffect(() => {
    if (!consent) return;
    // Само-восстановление push-подписки в списке рассылки об обновлениях — при
    // запуске и сразу после «Принимаю» (раньше стояло в main.tsx до чтения
    // настроек и уходило в сеть без спроса).
    void ensurePushRegistered();
    const sync = () => {
      if (document.visibilityState !== 'visible') return;
      void runSync().catch(() => {});
      // Заодно — напоминания, которые не удалось поставить раньше. Задачу
      // заводят на ходу, там же чаще всего и пропадает сеть, а повторить
      // попытку было некому: напоминание просто не срабатывало.
      void retryPendingReminders(async (ids) => {
        // Семейные задачи — в своей таблице. Без неё напоминание семейной
        // задачи, поставленное без сети, считалось «задачи больше нет» и
        // молча выпадало из очереди.
        const rows = [...(await db.tasks.bulkGet(ids)), ...(await db.familyTasks.bulkGet(ids))];
        return rows
          .filter((t): t is NonNullable<typeof t> => Boolean(t) && !t!.deletedAt && !t!.completedAt)
          .map((t) => ({
            id: t.id,
            title: t.title,
            dueDate: t.dueDate ?? null,
            dueTime: t.dueTime ?? null,
            remindBefore: t.remindBefore ?? null,
          }));
      }).catch(() => {});
    };
    // Возврат в приложение приходит парой событий подряд (visibilitychange и
    // focus), а теперь каждый вызов обмена во время идущего круга даёт ещё
    // один круг — пара стоила бы два опроса вместо одного. Схлопываем.
    let returnTimer: ReturnType<typeof setTimeout> | null = null;
    const onReturn = () => {
      kickSyncLive();
      if (returnTimer) return;
      returnTimer = setTimeout(() => {
        returnTimer = null;
        sync();
      }, 150);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        onReturn();
        return;
      }
      // Уходим в фон: накопленное отправляем сейчас. На iPhone таймеры
      // свёрнутого приложения не срабатывают, и правка, сделанная за секунду
      // до блокировки экрана, иначе оставалась бы на телефоне до следующего
      // открытия.
      flushSyncNow();
    };
    sync(); // при запуске
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onReturn);
    window.addEventListener('online', onReturn);
    const id = setInterval(sync, INTERVAL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('online', onReturn);
      clearInterval(id);
      if (returnTimer) clearTimeout(returnTimer);
    };
  }, [consent]);
  return null;
}
