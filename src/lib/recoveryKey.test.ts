import { describe, expect, it } from 'vitest';
import {
  extractRecoveryCode,
  groupCode,
  recoveryKeyFileText,
  recoveryKeyFilename,
} from './recoveryKey';

// Настоящий пакет доступа выглядит так: base64url длиной за две сотни.
const CODE =
  'eyJ2IjoxLCJhY2NvdW50SWQiOiIyOTNmOWI5Ni1lZDFlLTRiMjEtYmFiYS0xYzgyNzE4ZWU4MWIiLCJhdXRoVG9rZW4iOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiIsImtleSI6IkFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSJ9';

describe('файл ключа восстановления', () => {
  it('имя файла говорит, что это и когда сохранено', () => {
    expect(recoveryKeyFilename(new Date(2026, 8, 9))).toBe(
      'lifehearth-klyuch-vosstanovleniya-2026-09-09.txt',
    );
  });

  it('внутри файла сначала объяснение, потом код', () => {
    const text = recoveryKeyFileText(CODE, new Date(2026, 8, 9));
    expect(text).toContain('Ключ восстановления LifeHearth');
    expect(text).toContain('Настройки → Синхронизация');
    expect(text).toContain(CODE);
    // Объяснение выше кода: иначе файл открывают и видят мусор.
    expect(text.indexOf('Этим кодом')).toBeLessThan(text.indexOf(CODE));
  });
});

describe('что человек вставил', () => {
  it('голый код проходит как есть', () => {
    expect(extractRecoveryCode(CODE)).toBe(CODE);
    expect(extractRecoveryCode(`  ${CODE}\n`)).toBe(CODE);
  });

  it('файл целиком — код находится сам', () => {
    expect(extractRecoveryCode(recoveryKeyFileText(CODE))).toBe(CODE);
  });

  it('файл, пришедший письмом с лишними переносами, тоже разбирается', () => {
    expect(extractRecoveryCode(`Ключ восстановления LifeHearth\n\n\n   ${CODE}   \n\n`)).toBe(CODE);
  });

  it('мусор возвращается как есть — дальше его отвергнет разбор пакета с внятной ошибкой', () => {
    expect(extractRecoveryCode('привет')).toBe('привет');
  });
});

describe('код на экране', () => {
  it('разбит группами — чтобы сверить глазами и увидеть обрыв', () => {
    expect(groupCode('ABCDEFGHIJKLMNOP')).toBe('ABCDEFGH IJKLMNOP');
  });
});
