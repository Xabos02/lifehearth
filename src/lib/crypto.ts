// E2E-крипто для облачной синхронизации (Фаза 0).
// Содержимое записей шифруется НА устройстве (AES-256-GCM) перед отправкой;
// ключ никогда не уходит на сервер. На сервере лежит только шифротекст +
// открытые служебные поля (id/updatedAt/deletedAt) для дельта-синка. У
// таблиц, где id выведен из содержимого, id на проводе — HMAC (wireId).
// Чистый WebCrypto, без зависимостей — работает и в браузере, и в Node 20+.

// === base64url (без паддинга) ↔ байты; одинаково в браузере и Node ===
import { t } from './i18n';

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const IV_BYTES = 12; // рекомендованный размер nonce для AES-GCM

// === Ключ шифрования (AES-256-GCM) ===
export function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function exportKeyRaw(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bytesToB64url(new Uint8Array(raw));
}

export function importKeyRaw(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64urlToBytes(b64), { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ]);
}

// === Непрозрачный id записи на проводе (задача 35) ===
// У части таблиц id выведен из содержимого ('health:ferritin:2026-09-25'), и
// сервер по нему видел, какие анализы и когда. На провод идёт HMAC-SHA256 от
// «таблица/id» ключом, выведенным из ключа аккаунта: одинаковый на всех
// устройствах аккаунта (замер веса за день с двух телефонов — одна запись),
// а без ключа ни обратить, ни сверить с догадкой нельзя.
//
// Ключ id выводится тем же HMAC (HMAC(ключ аккаунта, метка) — PRF, как шаг
// expand у HKDF), а не через HKDF: HMAC-SHA256 в WebCrypto есть везде, где
// работает приложение, HKDF в Safari не проверен (облако без WebKit).
// Отдельный ключ, а не сам ключ аккаунта: ключ шифрования не должен служить
// ещё и ключом подписи.
const wireKeys = new WeakMap<CryptoKey, Promise<CryptoKey>>();
const HMAC = { name: 'HMAC', hash: 'SHA-256' } as const;

export function wireIdKey(accountKey: CryptoKey): Promise<CryptoKey> {
  let k = wireKeys.get(accountKey);
  if (!k) {
    k = (async () => {
      const raw = await crypto.subtle.exportKey('raw', accountKey);
      const base = await crypto.subtle.importKey('raw', raw, HMAC, false, ['sign']);
      const derived = await crypto.subtle.sign('HMAC', base, new TextEncoder().encode('lifehearth/wire-id/2'));
      return crypto.subtle.importKey('raw', derived, HMAC, false, ['sign']);
    })();
    wireKeys.set(accountKey, k);
  }
  return k;
}

/** 16 байт HMAC в base64url — 22 символа [A-Za-z0-9_-]. */
export async function wireId(k: CryptoKey, table: string, id: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${table}/${id}`));
  return bytesToB64url(new Uint8Array(sig).slice(0, 16));
}

// === Шифрование полезной нагрузки записи ===
// Формат шифротекста: base64url( iv(12 байт) ‖ ciphertext ).
//
// padTo > 1 — JSON дополняется пробелами до кратного padTo байт (JSON.parse
// хвостовые пробелы пропускает): у замеров здоровья длина записи иначе
// выдаёт, какой это анализ (гемоглобин длиннее веса). padTo = 1 — побайтно
// прежний формат.
export async function encryptJSON(key: CryptoKey, obj: unknown, padTo = 1): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const data = padTo > 1 ? new Uint8Array(Math.ceil(json.length / padTo) * padTo).fill(0x20) : json;
  if (data !== json) data.set(json);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const ctBytes = new Uint8Array(ct);
  const combined = new Uint8Array(iv.length + ctBytes.length);
  combined.set(iv, 0);
  combined.set(ctBytes, iv.length);
  return bytesToB64url(combined);
}

export async function decryptJSON<T>(key: CryptoKey, payload: string): Promise<T> {
  const combined = b64urlToBytes(payload);
  const iv = combined.slice(0, IV_BYTES);
  const ct = combined.slice(IV_BYTES);
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(data)) as T;
}

// === Идентификаторы аккаунта (на сервер уходят, ключ — нет) ===
/** id «строки» данных на сервере — какому набору принадлежат записи. */
export function newAccountId(): string {
  return crypto.randomUUID();
}

/** случайный bearer-токен для авторизации запросов к Worker. */
export function randomToken(bytes = 32): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// === Пакет доступа к аккаунту (v:1) ===
//
// Содержит всё нужное второму устройству: id аккаунта, токен доступа и ключ.
// Ключ внутри пакета — поэтому пакет так же секретен, как сам ключ, и живёт
// он вечно.
//
// Теперь у этого пакета одна роль: РЕЗЕРВНАЯ КОПИЯ ДОСТУПА, которую человек
// сохраняет файлом на случай потери телефона («без ключа облачные данные не
// восстановить» — так и написано на экране). Для сопряжения соседнего
// устройства он больше не показывается: там встреча через сервер (v:3, ниже),
// после которой перехваченный код уже ничего не открывает.
export interface PairingData {
  v: 1;
  accountId: string;
  authToken: string;
  key: string; // raw-ключ в base64url
}

// === Приглашение на встречу устройств (v:3) ===
//
// Это НЕ секрет: одноразовый публичный ключ и номер встречи. Подсмотренный
// код не даёт ничего — секреты аккаунта поедут отдельно, зашифрованные общим
// секретом, который выводится из пары ключей и на сервере не появляется.
export interface PairingMeet {
  v: 3;
  pairId: string;
  pub: string; // публичный ключ первого устройства, base64url (raw P-256)
}

export function encodeMeet(d: PairingMeet): string {
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(d)));
}

/** Разобрать код встречи. null — это не встреча (например, старый пакет v:1). */
export function decodeMeet(code: string): PairingMeet | null {
  try {
    const d = JSON.parse(new TextDecoder().decode(b64urlToBytes(code.trim()))) as PairingMeet;
    return d?.v === 3 && d.pairId && d.pub ? d : null;
  } catch {
    return null;
  }
}

export function encodePairing(d: PairingData): string {
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(d)));
}

export function decodePairing(code: string): PairingData {
  const json = new TextDecoder().decode(b64urlToBytes(code.trim()));
  const d = JSON.parse(json) as PairingData;
  if (d.v !== 1 || !d.accountId || !d.authToken || !d.key) {
    throw new Error(t('Некорректный код сопряжения'));
  }
  return d;
}

// === Пакет приглашения в СЕМЬЮ (v:2) ===
// Отдельный формат от device-сопряжения (v:1): шарится между людьми, содержит
// общий семейный ключ + имя семьи. Тот же AES-256-GCM ключ под капотом.
export interface FamilyPairingData {
  v: 2;
  familyId: string;
  familyToken: string;
  key: string; // общий семейный raw-ключ в base64url
  familyName: string;
}

export function encodeFamilyPairing(d: FamilyPairingData): string {
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(d)));
}

export function decodeFamilyPairing(code: string): FamilyPairingData {
  const json = new TextDecoder().decode(b64urlToBytes(code.trim()));
  const d = JSON.parse(json) as FamilyPairingData;
  if (d.v !== 2 || !d.familyId || !d.familyToken || !d.key) {
    throw new Error(t('Некорректный код приглашения в семью'));
  }
  return d;
}

// === Проверка кода доступа ===
// Нужна разделу «Женские дни»: сам код нигде не хранится, хранится только
// результат его прогонки через PBKDF2 с солью. Подобрать код по хешу тем
// дороже, чем больше итераций; 210 000 — рекомендация OWASP 2023 для
// PBKDF2-HMAC-SHA256.
//
// Честная граница этой защиты: она закрывает раздел от чужих глаз, а не
// данные от того, кто добрался до устройства и умеет открыть хранилище
// браузера. Записи в IndexedDB лежат как есть. Шифровать их ключом из кода
// было бы сильнее, но тогда забытый код означал бы безвозвратную потерю всей
// истории — а это прямо противоречит требованию «данные не должны теряться».

const PIN_ITERATIONS = 210_000;

export interface PinHash {
  salt: string;
  hash: string;
  iterations: number;
}

async function derivePin(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    256,
  );
  return bytesToB64url(new Uint8Array(bits));
}

export async function hashPin(pin: string): Promise<PinHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    salt: bytesToB64url(salt),
    hash: await derivePin(pin, salt, PIN_ITERATIONS),
    iterations: PIN_ITERATIONS,
  };
}

export async function verifyPin(pin: string, stored: PinHash): Promise<boolean> {
  const hash = await derivePin(pin, b64urlToBytes(stored.salt), stored.iterations);
  // Сравнение постоянного времени: обычное === выходит на первом же
  // несовпавшем символе, и по времени ответа код подбирается посимвольно.
  if (hash.length !== stored.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ stored.hash.charCodeAt(i);
  return diff === 0;
}

// === Приглашение под кодовым словом (v:3) ===
//
// Пакет v:2 содержал ключ группы открытым текстом: base64 — это запись, а не
// шифрование. Код передают людям обычными каналами, значит ключ от всей
// переписки проходил через чужой мессенджер, а перехвативший читал не только
// новые сообщения, но и всю прошлую историю — сервер отдаёт её при подключении.
//
// Здесь ключ и токен зашифрованы кодовым словом, которое приглашающий называет
// отдельно: голосом, при встрече, другим каналом. Перехваченный код без слова
// бесполезен. Слово короткое, поэтому его стойкость держится на PBKDF2 с
// 210 000 итераций: перебор восьми символов из 32-буквенного алфавита стоит
// порядка 10^12 попыток по 210 000 хешей каждая.
//
// Алфавит без похожих символов (нет 0/O, 1/I/l): код диктуют вслух, и «ноль
// или буква о» — это гарантированная ошибка ввода.

const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_WORD_LEN = 8;
const INVITE_ITERATIONS = 210_000;

/** Кодовое слово для приглашения. Показывается приглашающему, диктуется вслух. */
export function generateInviteWord(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(INVITE_WORD_LEN));
  let out = '';
  for (const b of bytes) out += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
  return out;
}

/** Приводит введённое слово к канону: верхний регистр, без пробелов и дефисов
 *  (код показывают группами по четыре, и человек их переносит).
 *
 *  Похожие символы НЕ подменяем: в алфавите нет ни O, ни 0, ни I, ни 1 — как
 *  раз чтобы подменять было нечего. Если человек ввёл O, он ослышался, и любая
 *  «догадка» с нашей стороны либо угадает, либо тихо испортит верный ввод. */
export function normalizeInviteWord(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Код группами по четыре: восемь символов подряд не читаются и не диктуются. */
export function formatInviteWord(word: string): string {
  return word.replace(/(.{4})(?=.)/g, '$1 ');
}

async function inviteKey(word: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(word),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: INVITE_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface SealedInvite {
  v: 3;
  familyId: string;
  /** Название группы остаётся открытым: по нему человек понимает, куда его
   *  зовут, ещё до ввода слова. Секретом оно не является — сервер его и так
   *  видит. */
  familyName: string;
  salt: string;
  payload: string;
  /** До какого момента приглашение считается годным (ISO). Проверяется на
   *  устройстве и потому обходится изменением часов — это не защита, а
   *  гигиена: старый код в переписке перестаёт работать сам собой. */
  expiresAt: string;
}

/** Что лежит внутри приглашения. keys/epoch появились вместе с исключением
 *  участников: после смены ключа группа хранит все прежние эпохи, и новому
 *  участнику их надо отдать целиком — иначе переписка до его прихода
 *  превратится у него в нечитаемые записи. */
export interface InviteSecrets {
  familyId: string;
  familyToken: string;
  key: string;
  familyName: string;
  keys?: Record<string, string>;
  epoch?: number;
}

export async function sealInvite(
  data: InviteSecrets,
  word: string,
  ttlHours = 24,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await inviteKey(word, salt);
  const sealed: SealedInvite = {
    v: 3,
    familyId: data.familyId,
    familyName: data.familyName,
    salt: bytesToB64url(salt),
    payload: await encryptJSON(k, {
      familyToken: data.familyToken,
      key: data.key,
      ...(data.keys ? { keys: data.keys, epoch: data.epoch ?? 0 } : {}),
    }),
    expiresAt: new Date(Date.now() + ttlHours * 3600_000).toISOString(),
  };
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(sealed)));
}

export class InviteExpiredError extends Error {
  constructor() {
    super(t('Срок действия приглашения истёк'));
    this.name = 'InviteExpiredError';
  }
}

export class InviteDamagedError extends Error {
  constructor() {
    super(t('Код приглашения неполный или повреждён'));
    this.name = 'InviteDamagedError';
  }
}

export class InviteWordError extends Error {
  constructor() {
    super(t('Неверное кодовое слово'));
    this.name = 'InviteWordError';
  }
}

/** Читает конверт, не расшифровывая: нужно, чтобы показать название группы и
 *  срок ещё до того, как человек введёт слово. */
export function peekInvite(code: string): SealedInvite {
  const json = new TextDecoder().decode(b64urlToBytes(code.trim()));
  const d = JSON.parse(json) as SealedInvite;
  if (d.v !== 3 || !d.familyId || !d.salt || !d.payload) {
    throw new Error('Некорректный код приглашения');
  }
  return d;
}

export async function openInvite(code: string, word: string): Promise<InviteSecrets> {
  const sealed = peekInvite(code);
  if (Date.parse(sealed.expiresAt) < Date.now()) throw new InviteExpiredError();
  const k = await inviteKey(normalizeInviteWord(word), b64urlToBytes(sealed.salt));
  try {
    const inner = await decryptJSON<Omit<InviteSecrets, 'familyId' | 'familyName'>>(
      k,
      sealed.payload,
    );
    return {
      familyId: sealed.familyId,
      familyName: sealed.familyName,
      familyToken: inner.familyToken,
      key: inner.key,
      keys: inner.keys,
      epoch: inner.epoch,
    };
  } catch {
    // AES-GCM не расшифровал — либо слово неверное, либо код испорчен.
    // Различить нельзя, и не нужно: для человека это один и тот же случай.
    throw new InviteWordError();
  }
}

// === Разбор кода, вставленного из мессенджера ===
//
// Код — сплошная base64url-строка в несколько сотен символов, и до поля ввода
// он доезжает через чат: с сопроводительным текстом («Вот код: …»), с
// невидимыми символами разметки, которые дописывают чаты и клавиатуры
// (U+200B/U+200E), порванный переносами при копировании из письма или PDF.
// Строгий парсер на таком вставленном падает, и человек видел «неверный код»
// на код, который на той стороне был верным.

/** Первые символы base64url от JSON-заголовков обоих форматов: у sealInvite и
 *  encodeFamilyPairing поле v стоит в объекте первым, поэтому префикс кода
 *  детерминирован — btoa('{"v":3') и btoa('{"v":2'). По нему битый код
 *  отличается от текста, не являющегося кодом вовсе. Закреплено тестом. */
const V3_CODE_PREFIX = 'eyJ2Ijoz';
const V2_CODE_PREFIX = 'eyJ2Ijoy';

/** Кандидаты в код из вставленного текста: сам текст без крайних пробелов,
 *  самый длинный base64url-кусок (код в обрамлении слов), склейка всех
 *  длинных кусков (код, порванный переносами или невидимыми символами).
 *  Куски короче 20 символов — сопроводительные слова, не код. */
function inviteCandidates(raw: string): string[] {
  const runs = raw.match(/[A-Za-z0-9_-]{20,}/g) ?? [];
  const longest = [...runs].sort((a, b) => b.length - a.length)[0];
  const joined = runs.join('');
  const out = [raw.trim()];
  if (longest && !out.includes(longest)) out.push(longest);
  if (joined && !out.includes(joined)) out.push(joined);
  return out;
}

export type PastedInvite =
  | { kind: 'v3'; code: string; peeked: SealedInvite }
  | { kind: 'v2'; code: string };

/** Разбирает вставленное «как есть». Возвращает распознанный код (его и
 *  передавать дальше в joinFamily) и, для v3, прочитанный без слова конверт.
 *  Бросает InviteDamagedError, если в тексте есть что-то похожее на код, но
 *  целиком он не разбирается — это «скопировано не всё», а не «не тот код».
 *  Обычная Error — кода в тексте нет вовсе. */
export function parsePastedInvite(raw: string): PastedInvite {
  const candidates = inviteCandidates(raw);
  for (const code of candidates) {
    try {
      return { kind: 'v3', code, peeked: peekInvite(code) };
    } catch {
      /* следующий кандидат */
    }
  }
  for (const code of candidates) {
    try {
      decodeFamilyPairing(code);
      return { kind: 'v2', code };
    } catch {
      /* следующий кандидат */
    }
  }
  const looksLikeCode = candidates.some(
    (c) => c.startsWith(V3_CODE_PREFIX) || c.startsWith(V2_CODE_PREFIX),
  );
  if (looksLikeCode) throw new InviteDamagedError();
  throw new Error('Это не код приглашения');
}

// === Личный конверт участника (ECDH P-256 + AES-256-GCM) ===
//
// Нужен ровно для одной вещи: раздать новый ключ группы оставшимся участникам
// так, чтобы исключённый его не получил. Общим каналом это сделать нельзя —
// исключённый ещё в группе и прочитает рассылку старым ключом. Значит каждому
// оставшемуся нужен свой конверт, который открывается только его ключом.
//
// Схема без подписи намеренно: конверт выводится из пары (отправитель,
// получатель), поэтому получатель, деривируя секрет ПУБЛИЧНЫМ ключом
// владельца, заодно убеждается, что конверт запечатал именно владелец. Никто
// другой такой же секрет не выведет — подпись была бы вторым ключом ради того
// же самого.
//
// Приватный ключ выгружаемый (extractable): конфиг группы реплицируется между
// СВОИМИ устройствами через аккаунтный E2E-синк, и у второго телефона тот же
// memberId. Без выгрузки он не смог бы открыть адресованный себе конверт.

const BOX_CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;

export function generateBoxKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(BOX_CURVE, true, ['deriveKey']) as Promise<CryptoKeyPair>;
}

/** Публичный ключ в сыром виде (65 байт несжатой точки P-256) — уходит всем. */
export async function exportBoxPublic(key: CryptoKey): Promise<string> {
  return bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

/** Приватный ключ в pkcs8 — только внутри аккаунтного шифротекста. */
export async function exportBoxPrivate(key: CryptoKey): Promise<string> {
  return bytesToB64url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', key)));
}

export function importBoxPublic(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64urlToBytes(b64), BOX_CURVE, true, []);
}

export function importBoxPrivate(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', b64urlToBytes(b64), BOX_CURVE, true, ['deriveKey']);
}

async function sharedKey(theirPublic: CryptoKey, myPrivate: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPublic },
    myPrivate,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Запечатать данные так, чтобы открыл только владелец theirPublic. */
export async function sealFor(
  theirPublic: CryptoKey,
  myPrivate: CryptoKey,
  data: unknown,
): Promise<string> {
  return encryptJSON(await sharedKey(theirPublic, myPrivate), data);
}

/** Открыть конверт, запечатанный владельцем theirPublic. */
export async function openFrom<T>(
  theirPublic: CryptoKey,
  myPrivate: CryptoKey,
  sealed: string,
): Promise<T> {
  return decryptJSON<T>(await sharedKey(theirPublic, myPrivate), sealed);
}

// === Эпоха ключа в шифротексте ===
//
// После исключения участника группа переходит на новый ключ, но старые
// сообщения остаются зашифрованными прежним — их надо продолжать читать.
// Поэтому шифротекст несёт номер эпохи: 'e2.<данные>'. Точки в base64url нет,
// так что разделитель однозначен. Эпоха 0 — записи, сделанные до появления
// ротации: у них префикса нет вовсе, и это же означает «читай общим ключом».

export function packEpoch(epoch: number, payload: string): string {
  return epoch > 0 ? `e${epoch}.${payload}` : payload;
}

export function unpackEpoch(raw: string): { epoch: number; payload: string } {
  const m = /^e(\d+)\.(.*)$/s.exec(raw);
  return m ? { epoch: Number(m[1]), payload: m[2] } : { epoch: 0, payload: raw };
}

/** sha256 в hex — тем же способом, что считает сервер. */
export async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
