// Текст напоминания уходит на сервер только шифротекстом.
//
// Напоминание срабатывает, когда приложение закрыто, поэтому время и текст
// лежат на сервере до срока. Раньше там лежали название задачи и подпись
// открытым текстом — в том числе семейной задачи, хотя переписка семьи
// зашифрована сквозным ключом. Владелец (24.09): «надо чтобы всё было
// защищено».
//
// Ключ — свой у каждого телефона, в отдельной маленькой базе на устройстве
// (не в основной: в копию и синхронизацию он попасть не должен). Напоминание
// всегда приходит на тот телефон, который его поставил, — туда же, где лежит
// ключ; расшифровывает его public/push-sw.js в момент показа. Сервер видит
// время срабатывания, адрес подписки и шифротекст.
//
// Ключ лежит СЫРЫМИ байтами, а не объектом CryptoKey. CryptoKey в IndexedDB
// WebKit заворачивает мастер-ключом устройства, а у сервис-воркера iOS
// 16.4–17 развернуть его нечем (у его страницы нет crypto-клиента, появился
// с Safari 18): get() молча отдаёт null, и каждое напоминание пришло бы без
// названия. Байты читаются везде одинаково. Защиты это почти не снимает:
// скрипт того же сайта и неизвлекаемым ключом расшифровал бы что угодно.
import { encryptJSON } from './crypto';

export const SEALED_PREFIX = 'e2e1:';
const DB_NAME = 'lifehearth-push-key';
const STORE = 'keys';
const KEY_ID = 'reminders';

function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Ключ устройства; заводится один раз. get и put — в ОДНОЙ readwrite-
 *  транзакции: IndexedDB выполняет их по очереди, и две вкладки на первом
 *  запуске не заведут по своему ключу (тогда одна запечатывала бы тем,
 *  которого в базе нет). Ключ идёт в дело после фиксации транзакции. */
async function loadOrCreateKey(): Promise<CryptoKey> {
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  const db = await openKeyDb();
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let value = fresh;
      const get = store.get(KEY_ID);
      get.onsuccess = () => {
        if (get.result instanceof Uint8Array) value = new Uint8Array(get.result);
        else store.put(fresh, KEY_ID);
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
}

// Одно обещание на страницу: два напоминания подряд при первом запуске иначе
// завели бы два ключа, и одно из них потом не расшифровалось бы.
let keyPromise: Promise<CryptoKey> | null = null;

export async function sealReminderText(title: string, body: string): Promise<string> {
  keyPromise ??= loadOrCreateKey().catch((e) => {
    keyPromise = null;
    throw e;
  });
  return SEALED_PREFIX + (await encryptJSON(await keyPromise, { t: title, b: body }));
}

/** Только для тестов: забыть ключ, закешированный в памяти страницы. */
export function forgetReminderKeyForTests(): void {
  keyPromise = null;
}
