import { useEffect } from 'react';
import { useNavigate } from 'react-router';

/** Мост от сервис-воркера к роутеру. Когда пользователь жмёт пуш-уведомление и
 *  приложение уже открыто, SW шлёт {type:'open-url', url}. Переходим на нужный
 *  экран БЕЗ перезагрузки — чтобы открывался конкретный чат, а не просто
 *  приложение (раньше SW делал только focus()). */
export function SwNavBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (!d || d.type !== 'open-url' || typeof d.url !== 'string') return;
      try {
        const u = new URL(d.url, location.origin);
        const base = import.meta.env.BASE_URL.replace(/\/$/, ''); // '/lifehearth' (prod) | '' (dev)
        let path = u.pathname + u.search;
        // '/life-hub' — адрес до переезда 07.09: его несут уведомления, пришедшие
        // раньше, и SW до обновления. Без этой ветки роутер получал чужой
        // префикс целиком и показывал «страница не найдена».
        for (const b of [base, '/life-hub']) {
          if (b && (path === b || path.startsWith(b + '/') || path.startsWith(b + '?'))) {
            path = path.slice(b.length) || '/';
            break;
          }
        }
        navigate(path);
      } catch {
        /* битый url — игнорируем */
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [navigate]);
  return null;
}
