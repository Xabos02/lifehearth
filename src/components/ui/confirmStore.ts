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
  /** true — глагол, false — кнопка отказа, null — шит закрыт мимо кнопок
   *  (тап по затемнению, свайп, крестик). */
  resolve: (ok: boolean | null) => void;
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
export async function confirmAction(opts: ConfirmOptions | string): Promise<boolean> {
  return (await chooseAction(opts)) === true;
}

/** Как confirmAction, но различает отказ кнопкой (false) и шит, закрытый мимо
 *  кнопок (null): когда у отказа своё действие («Только этот вид»), тап мимо
 *  должен ничего не делать, а не выполнять его. */
export function chooseAction(opts: ConfirmOptions | string): Promise<boolean | null> {
  const o: ConfirmOptions = typeof opts === 'string' ? { title: opts } : opts;
  if (!listener) {
    const text = o.message ? `${o.title}\n\n${o.message}` : o.title;
    return Promise.resolve(typeof window !== 'undefined' ? window.confirm(text) : false);
  }
  // Предыдущий незакрытый вопрос считаем отказом.
  pending?.resolve(null);
  return new Promise<boolean | null>((resolve) => {
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
