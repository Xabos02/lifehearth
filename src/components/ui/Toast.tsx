import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ToastContext } from './toastContext';

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = useCallback((msg: string) => {
    setMessage(msg);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 2500);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* role="status" + aria-live: всплывающее сообщение — единственный канал
          подтверждений в приложении («Скопировано», «Не удалось сохранить»), и
          без живого региона незрячий пользователь не узнаёт о нём вообще.
          Регион висит в DOM всегда, меняется только текст: вставленный вместе с
          сообщением, он озвучивается не во всех связках браузер-скринридер. */}
      <div
        // id — для слоя тоста на время перехода экранов (index.css).
        id="toast"
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+92px)] z-[60] flex justify-center px-6"
      >
        {message && (
          <div className="animate-fade-in rounded-full bg-lh-surface-2 px-4 py-2.5 text-sm font-medium shadow-lg shadow-black/30 border border-lh-border-strong">
            {message}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
