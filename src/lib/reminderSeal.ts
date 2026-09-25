// Текст напоминания уходит на сервер только шифротекстом.
//
// Напоминание срабатывает, когда приложение закрыто, поэтому время и текст
// лежат на сервере до срока. Раньше там лежали название задачи и подпись
// открытым текстом — в том числе семейной задачи, хотя переписка семьи
// зашифрована сквозным ключом. Владелец (24.09): «надо чтобы всё было
// защищено».
//
// Ключ — свой у каждого телефона, неизвлекаемый, в отдельной маленькой базе
// на устройстве (не в основной: в копию и синхронизацию он попасть не должен).
// Напоминание всегда приходит на тот телефон, который его поставил, — туда же,
// где лежит ключ; расшифровывает его public/push-sw.js в момент показа.
// Сервер видит только время срабатывания и адрес подписки.
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

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function loadOrCreateKey(): Promise<CryptoKey> {
  const db = await openKeyDb();
  try {
    const have = (await request(db.transaction(STORE).objectStore(STORE).get(KEY_ID))) as CryptoKey | undefined;
    if (have) return have;
    // Неизвлекаемый: достать его из браузера в виде байтов нельзя, а
    // сервис-воркер пользуется им как есть.
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(key, KEY_ID));
    return key;
  } finally {
    db.close();
  }
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
