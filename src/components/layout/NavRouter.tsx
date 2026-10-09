import { startTransition, useLayoutEffect, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { NavigationType, Router, UNSAFE_createBrowserHistory } from 'react-router';
import { NAV_BACK, NAV_TAB } from './navState';

/** BrowserRouter, который оборачивает смену экрана в View Transition
 *  (кривые и направления — index.css, PROTOCOL §6).
 *
 *  Свой, а не опция `viewTransition` у ссылок: в декларативном режиме React
 *  Router её молча игнорирует — document.startViewTransition он зовёт только
 *  из RouterProvider (проверено в 7.17). Здесь же все переходы — ссылки,
 *  navigate(), таб-бар — проходят через одну точку, history.listen.
 *
 *  Направление — по пометке источника, а не по адресу: стрелка «Назад» у нас
 *  — обычный переход вперёд на адрес родителя (§12, «/search» → «/» той же
 *  глубины), а вкладки человек расставляет сам, и по пути их не угадать. */
export function NavRouter({ basename, children }: { basename: string; children: ReactNode }) {
  const [history] = useState(() => UNSAFE_createBrowserHistory({ v5Compat: true }));
  const [state, setState] = useState({ action: history.action, location: history.location });

  useLayoutEffect(() => {
    let fromPath = history.location.pathname;
    let running: ViewTransition | undefined;
    return history.listen(({ action, location }) => {
      const samePage = location.pathname === fromPath;
      fromPath = location.pathname;
      // Из history, а не из аргумента: колбэк пропущенного перехода может
      // выполниться после следующего — пусть и он ставит последний адрес.
      const apply = () => setState({ action: history.action, location: history.location });
      // Анимируется только переход по ссылке на другой экран. REPLACE — подмена
      // адреса без смены экрана (редирект, /notes/new → /notes/<id>), смена
      // ?t= или #id — тот же экран. POP — «назад» системы: свайп от края на
      // iOS (и в Safari, и в установленном приложении — с iOS 12.2) рисует,
      // по отчётам, собственный сдвиг, и второй поверх него был бы двойным;
      // кнопка «назад» Android — тоже POP. Сами мы POP не делаем: «Назад» — ссылка.
      if (
        action !== NavigationType.Push ||
        samePage ||
        !('startViewTransition' in document) ||
        matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        startTransition(apply);
        return;
      }
      const nav = (location.state as { nav?: string } | null)?.nav;
      const root = document.documentElement;
      root.dataset.nav = nav === NAV_TAB.nav ? 'tab' : nav === NAV_BACK.nav ? 'pop' : 'push';
      const vt = document.startViewTransition(() => flushSync(apply));
      running = vt;
      // Атрибут — и вместе с ним имя слоя ленты — живёт только на время
      // перехода. Снимает его лишь последний переход: пропущенный
      // предыдущий иначе сорвал бы анимацию того, что уже идёт.
      void vt.finished.finally(() => {
        if (running === vt) delete root.dataset.nav;
      });
    });
  }, [history]);

  return (
    <Router basename={basename} location={state.location} navigationType={state.action} navigator={history}>
      {children}
    </Router>
  );
}
