// Копия файлом под паролем.
//
// Файл резервной копии уносит всё: задачи, заметки, финансы, здоровье,
// семейную переписку и «Женские дни». Открытым JSON его читал любой, кому
// файл попал в руки — пересланный себе в мессенджер, лежащий в «Загрузках»
// чужого компьютера, в общей папке iCloud. Теперь по умолчанию он шифруется
// паролем, который знает только человек.
//
// Схема: PBKDF2-SHA256 (600 000 итераций, рекомендация OWASP 2023+) выводит
// ключ AES-256-GCM из пароля и случайной соли; GCM даёт и тайну, и проверку
// целостности — неверный пароль и испорченный файл одинаково не расшифруются.
// Пароль нигде не хранится: забыл — копию не открыть никому, и нам тоже.
//
// Обёртка — тоже JSON с app: 'life-hub', чтобы файл узнавался как наш и
// старые копии (открытые) читались как прежде.

export const ENCRYPTED_BACKUP_FORMAT = 'lh-backup-aes256gcm-pbkdf2-v1';
const ITERATIONS = 600_000;
/** Короче — подбор по словарю становится делом минут. */
export const MIN_BACKUP_PASSWORD = 8;

export interface EncryptedBackupFile {
  app: 'life-hub';
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  exportedAt: string;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  iv: string;
  data: string;
}

export class WrongBackupPasswordError extends Error {
  constructor() {
    super('wrong password');
    this.name = 'WrongBackupPasswordError';
  }
}

// base64 частями: копия с фото весит десятки мегабайт, а
// String.fromCharCode(...bytes) на таком массиве падает с переполнением стека.
function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function isEncryptedBackup(parsed: unknown): parsed is EncryptedBackupFile {
  const b = parsed as Partial<EncryptedBackupFile> | null;
  return Boolean(b && typeof b === 'object' && b.app === 'life-hub' && b.format === ENCRYPTED_BACKUP_FORMAT);
}

/** Зашифровать текст копии (JSON) паролем. */
export async function encryptBackupText(
  json: string,
  password: string,
  exportedAt: string,
  iterations = ITERATIONS,
): Promise<EncryptedBackupFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json));
  return {
    app: 'life-hub',
    format: ENCRYPTED_BACKUP_FORMAT,
    // Дата открытым текстом — чтобы человек отличал копии, не вводя пароль.
    exportedAt,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toB64(salt) },
    iv: toB64(iv),
    data: toB64(new Uint8Array(ct)),
  };
}

/** Расшифровать: неверный пароль или порча файла — WrongBackupPasswordError. */
export async function decryptBackupText(file: EncryptedBackupFile, password: string): Promise<string> {
  const iterations = file.kdf?.iterations;
  if (typeof iterations !== 'number' || iterations < 100_000 || iterations > 10_000_000) {
    throw new WrongBackupPasswordError();
  }
  try {
    const key = await deriveKey(password, fromB64(file.kdf.salt), iterations);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(file.iv) }, key, fromB64(file.data));
    return new TextDecoder().decode(pt);
  } catch {
    throw new WrongBackupPasswordError();
  }
}
