import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { callManager } from '../../lib/family/familyCall';

const CHECK_INTERVAL = 15 * 60 * 1000; // проверять обновление раз в 15 мин

// Обновление — только вне звонка: перезагрузка посреди разговора убивала
// соединение без единого сигнала собеседнику. К перезагрузке ведут два пути:
// свой controllerchange ниже и обработчик самого плагина (в autoUpdate он
// перезагружает страницу на 'activated' сам, если не передать onNeedReload).
// Оба идут сюда, и новая версия ждёт конца звонка.
const inCall = () => callManager.getSnapshot().status !== 'idle';
let reloading = false;
function reloadWhenIdle() {
  if (reloading) return;
  reloading = true;
  if (!inCall()) return window.location.reload();
  const unsub = callManager.subscribe(() => {
    if (inCall()) return;
    unsub();
    window.location.reload();
  });
}

/**
 * Тихое авто-обновление PWA (registerType: 'autoUpdate'). Новый service worker
 * активируется сам (skipWaiting + clientsClaim), а при смене контроллера
 * страница один раз перезагружается на свежую версию. Кнопки «Обновить» больше
 * нет — на iOS-PWA она была ненадёжной и юзер застревал на старом кэше. UI не
 * рендерит; периодически дёргает registration.update(), чтобы быстро подхватить
 * свежий билд (iOS сам проверяет sw.js редко).
 */
export function ReloadPrompt() {
  useRegisterSW({
    onNeedReload: reloadWhenIdle,
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      // Во время звонка не проверяем вовсе: установка новой версии тянет
      // кэш по той же сети, что и разговор, и кончается перезагрузкой.
      const check = () => {
        if (!inCall()) registration.update().catch(() => {});
      };
      check(); // сразу при запуске
      setInterval(check, CHECK_INTERVAL);
      // при возврате в приложение (из фона/другой вкладки) — проверить снова
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
  });

  // Когда новый SW перехватывает страницу (controllerchange) — перезагружаемся
  // на свежую версию. Гард hadController: при ПЕРВОЙ установке SW контроллер
  // тоже меняется (null → SW), но контент уже свежий — лишний reload не нужен.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let hadController = !!navigator.serviceWorker.controller;
    const onChange = () => {
      if (!hadController) {
        hadController = true; // первая установка — без перезагрузки
        return;
      }
      reloadWhenIdle();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange);
  }, []);

  return null;
}
