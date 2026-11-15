// Подтверждение действия — шит с кнопкой-глаголом вместо window.confirm.
//
// window.confirm рисовал серый системный алерт с «ОК/Отмена» (PROTOCOL их
// запрещает) и ломал стиль. Здесь — обещание, которое разрешает ConfirmHost
// (смонтирован один раз в App.tsx): вызов остаётся однострочным, как был.

export interface ConfirmOptions {
  /** Вопрос — заголовок шита. */
  title: string;
  /** Пояснение под заголовком (последствия). */
  message?: string;
  /** Глагол на кнопке: «Удалить», «Выйти», «Забрать». */
  confirmLabel?: string;
  /** Подпись отказа. По умолчанию «Не сейчас». */
  cancelLabel?: string;
  /** Разрушительное действие — кнопка красная. По умолчанию true. */
  danger?: boolean;
}

export interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

type Listener = (req: ConfirmRequest | null) => void;
let listener: Listener | null = null;
let pending: ConfirmRequest | null = null;

export function subscribeConfirm(l: Listener): () => void {
  listener = l;
  if (pending) l(pending);
  return () => {
    if (listener === l) listener = null;
  };
}

/** Спрашивает подтверждение. Без смонтированного хоста (тесты, ранний старт)
 *  откатывается на window.confirm — действие не должно молча пропасть. */
export function confirmAction(opts: ConfirmOptions | string): Promise<boolean> {
  const o: ConfirmOptions = typeof opts === 'string' ? { title: opts } : opts;
  if (!listener) {
    const text = o.message ? `${o.title}\n\n${o.message}` : o.title;
    return Promise.resolve(typeof window !== 'undefined' ? window.confirm(text) : false);
  }
  // Предыдущий незакрытый вопрос считаем отказом.
  pending?.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = {
      danger: true,
      ...o,
      resolve: (ok) => {
        pending = null;
        listener?.(null);
        resolve(ok);
      },
    };
    listener?.(pending);
  });
}
