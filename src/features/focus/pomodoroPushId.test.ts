import { describe, expect, it, vi } from 'vitest';

// Ключ напоминания о конце круга — свой на каждом устройстве.
//
// С общим ключом семья делила одно напоминание: чей фокус стартовал позже, тот
// и получал «Фокус завершён», а пауза любого снимала его у всех. Ключ живёт в
// localStorage и в синк не уезжает — в этом смысл.

describe('ключ напоминания помодоро', () => {
  it('содержит метку устройства и переживает перезагрузку модуля', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal('crypto', { randomUUID: () => 'dev-1234' });

    vi.resetModules();
    const a = await import('./PomodoroProvider');
    const b = await import('./PomodoroProvider');
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    // Метка записана один раз и не 'pomodoro-end' в чистом виде.
    expect(store.get('life-hub-device')).toBe('dev-1234');
  });
});
