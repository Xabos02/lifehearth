import { createContext, useContext } from 'react';

// Контекст и хук вынесены из Toast.tsx: файл с компонентом должен
// экспортировать только компоненты, иначе ломается Fast Refresh
// (react-refresh/only-export-components).

export interface ToastOptions {
  /** Кнопка в плашке — «Вернуть» после удаления (макет: «Удалено · Вернуть»). */
  action?: { label: string; onClick: () => void };
  /** Смысловая иконка слева: success — галочка. */
  tone?: 'success';
}

export type ShowToast = (message: string, opts?: ToastOptions) => void;

export const ToastContext = createContext<ShowToast>(() => {});

export function useToast() {
  return useContext(ToastContext);
}
