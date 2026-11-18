import { describe, expect, it } from 'vitest';
import {
  decryptBackupText,
  encryptBackupText,
  isEncryptedBackup,
  WrongBackupPasswordError,
} from './backupCrypto';

const FAST = 100_000; // нижняя допустимая граница — чтобы тесты шли быстро

describe('копия файлом под паролем', () => {
  it('шифрует и расшифровывает; открытого текста в файле нет', async () => {
    const json = JSON.stringify({ app: 'life-hub', data: { notes: [{ title: 'Ферритин 12, к врачу' }] } });
    const file = await encryptBackupText(json, 'correct horse', '2026-11-18T10:00:00.000Z', FAST);
    const raw = JSON.stringify(file);
    expect(raw).not.toContain('Ферритин');
    expect(raw).not.toContain('notes');
    expect(isEncryptedBackup(JSON.parse(raw))).toBe(true);
    expect(await decryptBackupText(JSON.parse(raw), 'correct horse')).toBe(json);
  });

  it('неверный пароль и испорченный файл — WrongBackupPasswordError', async () => {
    const file = await encryptBackupText('{"a":1}', 'password-1', 'x', FAST);
    await expect(decryptBackupText(file, 'password-2')).rejects.toBeInstanceOf(WrongBackupPasswordError);
    const broken = { ...file, data: file.data.slice(0, -4) + 'AAAA' };
    await expect(decryptBackupText(broken, 'password-1')).rejects.toBeInstanceOf(WrongBackupPasswordError);
    // Подложенное число итераций (1 — мгновенный подбор) не принимаем.
    await expect(decryptBackupText({ ...file, kdf: { ...file.kdf, iterations: 1 } }, 'password-1')).rejects.toBeInstanceOf(
      WrongBackupPasswordError,
    );
  });

  it('соль и iv каждый раз новые — одинаковые данные дают разные файлы', async () => {
    const a = await encryptBackupText('{}', 'same-pass', 'x', FAST);
    const b = await encryptBackupText('{}', 'same-pass', 'x', FAST);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.data).not.toBe(b.data);
  });

  it('большая копия (несколько МБ) не роняет кодирование', async () => {
    const big = 'я'.repeat(3_000_000);
    const file = await encryptBackupText(big, 'long-pass', 'x', FAST);
    expect((await decryptBackupText(file, 'long-pass')).length).toBe(big.length);
  });

  it('открытая копия прежнего формата шифрованной не считается', () => {
    expect(isEncryptedBackup({ app: 'life-hub', schemaVersion: 24, data: {} })).toBe(false);
    expect(isEncryptedBackup(null)).toBe(false);
  });
});
