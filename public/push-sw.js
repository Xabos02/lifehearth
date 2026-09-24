// Подключается в сгенерированный Workbox-SW через workbox.importScripts.
// Показывает уведомление по входящему пушу и фокусирует приложение по клику.

// База приложения — из области действия самого SW, а не строкой. 07.09 адрес
// сменился с /life-hub/ на /lifehearth/, а здесь остался прежний: тап по пушу
// при закрытом приложении открывал страницу-объявление о переезде, при
// открытом — «страница не найдена». Из scope база верна и в разработке ('/').
function appBase() {
  return new URL(self.registration.scope).pathname;
}
// Уведомления, пришедшие до правки, так и лежат в центре уведомлений со
// старым адресом внутри — переводим его на нынешнюю базу при тапе.
function toAppUrl(url) {
  return url.replace(/^\/life-hub\//, appBase());
}
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || 'Напоминание';
  // Звонок: renotify перезванивает одной карточкой на каждый пуш серии
  // «дозвона», requireInteraction держит её на экране до ответа (Android;
  // iOS оба флага игнорирует — там серия сама складывается в баннеры со звуком).
  const isCall = !!data.call;
  const tag = data.taskId || data.tag || undefined;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: appBase() + 'icons/icon-192.png',
      badge: appBase() + 'icons/icon-192.png',
      tag: tag,
      renotify: isCall && !!tag, // renotify без tag — TypeError, уведомление не показалось бы вовсе
      requireInteraction: isCall,
      data: { url: data.family ? appBase() + 'more/family' + (data.familyId ? '?g=' + data.familyId : '') : appBase() },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = toAppUrl((event.notification.data && event.notification.data.url) || appBase());
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) {
          // Уже открытое окно: просим приложение перейти на нужный экран (чат
          // конкретной группы) без перезагрузки и наводим фокус. Раньше делался
          // только focus() — поэтому открывалось приложение, а не сам чат.
          try {
            c.postMessage({ type: 'open-url', url: url });
          } catch (e) {
            /* клиент не принял сообщение */
          }
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
