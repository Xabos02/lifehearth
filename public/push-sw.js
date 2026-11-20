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
// Карточки звонка (tag 'family-call:<id>'). iOS tag не склеивает — каждый пуш
// серии «Входящий звонок» ложится своей карточкой (WebKit: идентификатор
// уведомления — UUID, не tag; bug 258922), а закрыть уведомление даёт не
// раньше 30 с после показа (Notification::close, младшие молча пропускает).
// Поэтому закрываем при каждом случае: что старше 30 с — уйдёт. Ждать здесь,
// пока подрастут младшие, нельзя: долгий обработчик пуша WebKit может
// остановить и засчитать тихим пушем, а после трёх таких iOS снимает подписку.
async function closeCallCards(tag) {
  try {
    const list = await self.registration.getNotifications({ tag: tag });
    for (const n of list) n.close();
  } catch (e) {
    /* getNotifications недоступен — карточки останутся */
  }
}
// Имя участника из базы этого телефона (Dexie 'life-hub', таблица
// familyMembers): в пуше о звонке сервер шлёт только номер звонящего — имён он
// не видит, они зашифрованы семейным ключом. null — имени нет или база молчит.
function memberName(id) {
  return new Promise((resolve) => {
    if (typeof id !== 'string' || !id) return resolve(null);
    let req;
    try {
      req = indexedDB.open('life-hub');
    } catch (e) {
      return resolve(null);
    }
    // Базы ещё нет (приложение не открывали) — не создаём пустую вместо неё.
    req.onupgradeneeded = () => req.transaction.abort();
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const get = db.transaction('familyMembers').objectStore('familyMembers').get(id);
        get.onsuccess = () => {
          db.close();
          const name = get.result && typeof get.result.displayName === 'string' ? get.result.displayName.trim() : '';
          resolve(name || null);
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
// Уведомление о звонке не ждёт базу дольше полутора секунд — покажется без имени.
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
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
  // iOS оба флага игнорирует — там каждый пуш серии свой баннер со звуком).
  const isCall = !!data.call;
  const isMissed = !!data.missed;
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
      // До показа, не после: на Android tag и так заменяет карточку, и закрытие
      // после показа сняло бы только что показанную.
      // Кто звонит — как у телефона: «Мама звонит», «Пропущенный звонок / Мама».
      if ((isCall || isMissed) && data.from) {
        const name = await withTimeout(memberName(data.from), 1500);
        if (name && isCall) title = name + ' звонит';
        if (name && isMissed) body = name;
      }
      if (tag && (isCall || isMissed)) await closeCallCards(tag);
      // Показ — всегда: пуш без уведомления iOS считает тихим и после трёх
      // таких отзывает подписку.
      await self.registration.showNotification(title, {
        body: body,
        icon: appBase() + 'icons/icon-192.png',
        badge: appBase() + 'icons/icon-192.png',
        tag: tag,
        renotify: isCall && !!tag, // renotify без tag — TypeError, уведомление не показалось бы вовсе
        requireInteraction: isCall,
        data: {
          url: data.family ? appBase() + 'more/family' + (data.familyId ? '?g=' + data.familyId : '') : appBase(),
          missed: isMissed,
        },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = toAppUrl((event.notification.data && event.notification.data.url) || appBase());
  const tag = event.notification.tag || '';
  event.waitUntil(
    // Тап по карточке звонка — остальные карточки того же звонка больше не нужны.
    (tag.startsWith('family-call:') ? closeCallCards(tag) : Promise.resolve()).then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true })).then((clients) => {
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
