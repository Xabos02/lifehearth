import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { listFamilyConfigs } from '../lib/family/familyState';
import { setAway, subscribeSignals } from '../lib/family/familyChat';
import { callManager, useCall } from '../lib/family/familyCall';
import { armRingtoneUnlock } from '../lib/family/ringtone';
import { CallOverlay, MinimizedCallBar } from '../features/family/CallOverlay';

/** Карточки серии «Входящий звонок» в центре уведомлений. iOS не склеивает их
 *  по tag и не даёт закрыть моложе 30 с (см. push-sw.js) — младшие close()
 *  молча пропускает. «Пропущенные» не трогаем: их человек должен увидеть.
 *  Идёт входящий — тоже не трогаем: на Android и компьютере закрытая карточка
 *  вернулась бы следующим пушем серии. */
function closeCallCards() {
  if (callManager.getSnapshot().status === 'incoming') return;
  void navigator.serviceWorker?.ready
    .then(async (reg) => {
      for (const n of await reg.getNotifications()) if (n.tag.startsWith('family-call:') && !n.data?.missed) n.close();
    })
    .catch(() => {});
}

/** Слушает сигналы звонков по ВСЕМ включённым группам (чтобы входящий ловился
 *  на любом экране) и рендерит оверлей активного звонка поверх приложения.
 *  Соединения держит FamilyRunner — здесь только подписка на сигналы. */
export function CallRunner() {
  useEffect(() => armRingtoneUnlock(), []);
  const sig = useLiveQuery(async () => {
    const cfgs = await listFamilyConfigs();
    return cfgs
      .filter((c) => c.enabled)
      .map((c) => c.familyId)
      .sort()
      .join(',');
  }, []);

  useEffect(() => {
    if (!sig) return;
    const ids = sig.split(',').filter(Boolean);
    const unsubs = ids.map((fid) => subscribeSignals(fid, (frame) => void callManager.onSignal(fid, frame)));
    return () => unsubs.forEach((u) => u());
  }, [sig]);

  const snap = useCall();
  // Свёрнуто, и разговора нет — сервер звонит сюда пушами: на iOS свёрнутое
  // приложение заморожено, входящий в нём не зазвонит. Входящий, уже
  // показанный в фоне, тоже не разговор — пуш нужен, чтобы его услышать. Идущий
  // разговор не трогаем: его повторные приглашения (переподключение) стали бы
  // пушем «Входящий звонок» посреди разговора.
  useEffect(() => {
    const idle = snap.status === 'idle' || snap.status === 'ended' || snap.status === 'incoming';
    const sync = () => {
      setAway(idle && document.visibilityState === 'hidden');
      // Открыли приложение, звонка нет — хвост серии в уведомлениях не нужен.
      if (document.visibilityState === 'visible' && (snap.status === 'idle' || snap.status === 'ended')) closeCallCards();
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [snap.status]);
  // Ответили, отказали или звонок кончился — карточки серии больше не нужны,
  // но сейчас они моложе 30 с.
  useEffect(() => {
    if (snap.status === 'connecting' || snap.status === 'ended') setTimeout(closeCallCards, 31_000);
  }, [snap.status]);
  // Свёрнутый звонок живёт здесь, а не в оверлее: он должен пережить и
  // размонтирование полноэкранного оверлея, и переходы между экранами
  // приложения — стрелка «назад» в оверлее лишь переключает этот флаг.
  const [minimized, setMinimized] = useState(false);
  useEffect(() => {
    // Новый звонок (входящий/исходящий) всегда открывается на весь экран;
    // сброс на 'idle' — тоже подстраховка на случай, если флаг залип.
    if (snap.status === 'idle' || snap.status === 'incoming' || snap.status === 'outgoing') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- сброс сворачивания на новый/оконченный звонок
      setMinimized(false);
    }
  }, [snap.status]);

  if (snap.status === 'idle') return null;
  if (minimized) return <MinimizedCallBar snap={snap} onExpand={() => setMinimized(false)} />;
  return <CallOverlay snap={snap} onMinimize={() => setMinimized(true)} />;
}
