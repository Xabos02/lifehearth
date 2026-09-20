import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { listFamilyConfigs } from '../lib/family/familyState';
import { subscribeSignals } from '../lib/family/familyChat';
import { callManager, useCall } from '../lib/family/familyCall';
import { armRingtoneUnlock } from '../lib/family/ringtone';
import { CallOverlay, MinimizedCallBar } from '../features/family/CallOverlay';

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
