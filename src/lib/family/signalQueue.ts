// Сигналы звонка, отправленные, пока сокет переподключается.
//
// Раньше такой кадр молча пропадал: телефон только что проснулся, сокет ещё
// поднимается, а ответ на звонок и маршруты уже собраны. Потерянный поздний
// маршрут ответившего — и звонящему не через что до него достучаться.
// Теперь кадр ждёт в очереди и уходит, как только связь с сервером есть.

export interface QueuedSignal {
  at: number;
  frame: { to: string; call: string; kind: string; data: string | null };
}

// Сигнал старше этого не нужен: звонок к тому времени либо соединился, либо
// закончился, а приглашение звонящий и так повторяет каждые 2,5 с.
const SIGNAL_TTL_MS = 15_000;
// ponytail: потолок на случай долгого обрыва — маршрутов в звонке десятки.
const SIGNAL_QUEUE_MAX = 100;

/** Поставить кадр в очередь. Всё, кроме маршрутов, — последнее слово: копия
 *  того же сигнала того же звонка заменяет прежнюю (приглашение повторяется
 *  каждые 2,5 с, и за обрыв набралась бы пачка). Маршруты копятся все. */
export function enqueueSignal(q: QueuedSignal[], frame: QueuedSignal['frame'], now: number): QueuedSignal[] {
  const kept = q.filter(
    (s) =>
      now - s.at < SIGNAL_TTL_MS &&
      (frame.kind === 'ice' || s.frame.kind !== frame.kind || s.frame.call !== frame.call || s.frame.to !== frame.to),
  );
  kept.push({ at: now, frame });
  return kept.slice(-SIGNAL_QUEUE_MAX);
}

/** Что ещё стоит отправить — по порядку постановки. */
export function freshSignals(q: QueuedSignal[], now: number): QueuedSignal['frame'][] {
  return q.filter((s) => now - s.at < SIGNAL_TTL_MS).map((s) => s.frame);
}
