import { describe, expect, it } from 'vitest';
import { APP_VERSION, RELEASES, compareVersions, pushTextFor } from './changelog';

const LIMIT = 140;

describe('changelog', () => {
  it('версия приложения — версия первого выпуска', () => {
    expect(APP_VERSION).toBe(RELEASES[0].version);
  });

  it('выпуски идут от новых к старым', () => {
    for (let i = 1; i < RELEASES.length; i++) {
      expect(compareVersions(RELEASES[i - 1].version, RELEASES[i].version)).toBe(1);
    }
  });

  it('двузначная часть версии больше однозначной', () => {
    // Ловушка строкового сравнения: '1.10.0' < '1.9.0' по буквам. Пока
    // сравнение было строковым, первый же выпуск 1.10.0 не показался бы.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('2.0.0', '1.99.0')).toBe(1);
    expect(compareVersions('1.9.1', '1.9.1')).toBe(0);
    expect(compareVersions('1.9', '1.9.1')).toBe(-1);
  });

  it('у каждого выпуска есть дата и хотя бы один пункт', () => {
    for (const r of RELEASES) {
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.items.length).toBeGreaterThan(0);
      for (const item of r.items) expect(item.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('pushTextFor', () => {
  it('текст всех выпусков влезает в лимит уведомления', () => {
    // Воркер режет по 140 символов без разбора. Если сюда попадёт больше —
    // человек получит уведомление, оборванное на полуслове.
    for (const r of RELEASES) {
      expect(pushTextFor(r).length).toBeLessThanOrEqual(LIMIT);
    }
  });

  it('первый пункт каждого выпуска сам по себе влезает целиком', () => {
    // Иначе уведомление всегда будет с многоточием — обрезка есть, но она
    // страховка, а не нормальный режим.
    for (const r of RELEASES) {
      expect(r.items[0].length).toBeLessThanOrEqual(LIMIT);
    }
  });

  it('набирает столько пунктов, сколько влезает', () => {
    const text = pushTextFor({
      version: '9.9.9',
      date: '2026-01-01',
      items: ['Раз', 'Два', 'Три'],
    });
    expect(text).toBe('Раз; Два; Три');
  });

  it('слишком длинный первый пункт режет по границе слова', () => {
    const long = 'слово '.repeat(40).trim();
    const text = pushTextFor({ version: '9.9.9', date: '2026-01-01', items: [long] });
    expect(text.length).toBeLessThanOrEqual(LIMIT);
    expect(text.endsWith('…')).toBe(true);
    // Обрыв именно по слову: перед многоточием не должно быть огрызка.
    expect(text.slice(0, -1).endsWith('слово')).toBe(true);
  });

  it('не роняется на пункте без пробелов', () => {
    const text = pushTextFor({
      version: '9.9.9',
      date: '2026-01-01',
      items: ['x'.repeat(300)],
    });
    expect(text.length).toBeLessThanOrEqual(LIMIT);
  });
});
