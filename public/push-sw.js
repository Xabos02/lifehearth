// Подключается в сгенерированный Workbox-SW через workbox.importScripts.
// Показывает уведомление по входящему пушу и фокусирует приложение по клику.

// База приложения — из области действия самого SW, а не строкой. 07.09 адрес
// сменился с /life-hub/ на /lifehearth/, а здесь остался прежний: тап по пушу
// при закрытом приложении открывал страницу-объявление о переезде, при
// открытом — «страница не найдена». Из scope база верна и в разработке ('/').
function appBase() {
  return new URL(self.registration.scope).pathname;
}
// Текст напоминания приходит шифротекстом (src/lib/reminderSeal.ts): сервер
// хранит его до срока и видеть не должен. Ключ — сырые байты в базе
// устройства, общей у страницы и сервис-воркера (почему байты, а не CryptoKey,
// — там же); формат тот же, что у encryptJSON:
// 'e2e1:' + base64url(iv(12) ‖ шифротекст).
const SEALED_PREFIX = 'e2e1:';
function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function reminderKey() {
  return new Promise((resolve) => {
    const req = indexedDB.open('lifehearth-push-key', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const get = db.transaction('keys').objectStore('keys').get('reminders');
        get.onsuccess = () => {
          db.close();
          resolve(get.result instanceof Uint8Array ? get.result : null);
        };
        get.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch (e) {
        db.close();
        resolve(null);
      }
    };
  });
}
// null — не вышло (ключа нет: переустановка, другое устройство, чистка
// данных сайта). Тогда уведомление нейтральное — открытым текст не бывает.
async function unseal(text) {
  try {
    const raw = await reminderKey();
    if (!raw) return null;
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const all = b64urlToBytes(text.slice(SEALED_PREFIX.length));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (e) {
    return null;
  }
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
  let title = data.title || 'Напоминание';
  let body = data.body || '';
  // Звонок: renotify перезванивает одной карточкой на каждый пуш серии
  // «дозвона», requireInteraction держит её на экране до ответа (Android;
  // iOS оба флага игнорирует — там серия сама складывается в баннеры со звуком).
  const isCall = !!data.call;
  const tag = data.taskId || data.tag || undefined;
  event.waitUntil(
    (async () => {
      if (body.startsWith(SEALED_PREFIX)) {
        const open = await unseal(body);
        if (open) {
          title = open.t || title;
          body = open.b || '';
        } else {
          body = 'Откройте приложение, чтобы увидеть, о чём оно';
        }
      }
      await self.registration.showNotification(title, {
        body: body,
        icon: appBase() + 'icons/icon-192.png',
        badge: appBase() + 'icons/icon-192.png',
        tag: tag,
        renotify: isCall && !!tag, // renotify без tag — TypeError, уведомление не показалось бы вовсе
        requireInteraction: isCall,
        data: { url: data.family ? appBase() + 'more/family' + (data.familyId ? '?g=' + data.familyId : '') : appBase() },
      });
    })(),
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
