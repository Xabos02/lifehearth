import { useCallback, useRef, useState, type ReactNode } from 'react';
import { GCheck as Check } from './glyphs';
import { ICON, STROKE_STRONG } from './icons';
import { ToastContext, type ToastOptions } from './toastContext';

/** Сколько живёт плашка. С кнопкой «Вернуть» — дольше: человеку нужно успеть
 *  понять, что удалил не то, и дотянуться до кнопки. */
const PLAIN_MS = 2500;
const ACTION_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; opts?: ToastOptions } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = useCallback((message: string, opts?: ToastOptions) => {
    setToast({ message, opts });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), opts?.action ? ACTION_MS : PLAIN_MS);
  }, []);

  const action = toast?.opts?.action;

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* role="status" + aria-live: всплывающее сообщение — единственный канал
          подтверждений в приложении («Скопировано», «Не удалось сохранить»), и
          без живого региона незрячий пользователь не узнаёт о нём вообще.
          Регион висит в DOM всегда, меняется только текст: вставленный вместе с
          сообщением, он озвучивается не во всех связках браузер-скринридер. */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+73px)] z-[60] mx-auto flex max-w-lg justify-center px-4"
      >
        {toast && (
          // Макет «Корзина»: плашка на холсте, r12, иконка · текст · глагол.
          <div
            className={`animate-fade-in flex min-h-12 items-center gap-3 rounded-lh-btn border border-lh-border-strong bg-lh-surface-2 text-sm font-medium shadow-[var(--shadow-pop)] ${
              action ? 'pointer-events-auto w-full py-1 pr-1 pl-4' : 'px-4 py-2.5'
            }`}
          >
            {toast.opts?.tone === 'success' && (
              <Check size={ICON.inline} strokeWidth={STROKE_STRONG} className="shrink-0 text-success" />
            )}
            <span className="flex-1">{toast.message}</span>
            {action && (
              <button
                type="button"
                onClick={() => {
                  clearTimeout(timer.current);
                  setToast(null);
                  action.onClick();
                }}
                className="min-h-11 shrink-0 rounded-lh-sm px-3 font-semibold text-lh-accent active:opacity-60"
              >
                {action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
