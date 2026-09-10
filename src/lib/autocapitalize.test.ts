import { describe, expect, it } from 'vitest';
import { isRefused, shouldCapitalizeInLine } from './autocapitalize';

describe('заглавная в начале строки и пункта', () => {
  it('пустая строка — поднимаем', () => {
    expect(shouldCapitalizeInLine('', 'п')).toBe(true);
  });

  it('после автонумерации «2. » — поднимаем: это и есть жалоба владельца', () => {
    expect(shouldCapitalizeInLine('2. ', 'н')).toBe(true);
    expect(shouldCapitalizeInLine('10. ', 'н')).toBe(true);
    expect(shouldCapitalizeInLine('3) ', 'н')).toBe(true);
  });

  it('маркеры списка тоже начало пункта', () => {
    for (const prefix of ['- ', '• ', '* ', '  - ']) {
      expect(shouldCapitalizeInLine(prefix, 'т')).toBe(true);
    }
  });

  it('отступ в начале строки не мешает', () => {
    expect(shouldCapitalizeInLine('   ', 'т')).toBe(true);
  });

  it('в середине строки не вмешиваемся никогда', () => {
    expect(shouldCapitalizeInLine('надо купить ', 'м')).toBe(false);
    expect(shouldCapitalizeInLine('и т.', 'д')).toBe(false);
    expect(shouldCapitalizeInLine('2. первый пункт, ', 'п')).toBe(false);
  });

  it('цифры, знаки и уже заглавные не трогаем', () => {
    expect(shouldCapitalizeInLine('', '5')).toBe(false);
    expect(shouldCapitalizeInLine('', '-')).toBe(false);
    expect(shouldCapitalizeInLine('', 'П')).toBe(false);
    expect(shouldCapitalizeInLine('', null)).toBe(false);
  });

  it('вставка нескольких символов разом — не наш случай', () => {
    expect(shouldCapitalizeInLine('', 'привет')).toBe(false);
  });
});

describe('отказ от автозаглавной', () => {
  it('стёр нашу букву и набрал ту же — второй раз не поднимаем', () => {
    expect(isRefused({ char: 'i', offset: 5, undone: true }, 'i', 4)).toBe(true);
  });

  it('другая буква или другое место — обычный ввод', () => {
    expect(isRefused({ char: 'i', offset: 5, undone: true }, 'a', 4)).toBe(false);
    expect(isRefused({ char: 'i', offset: 5, undone: true }, 'i', 9)).toBe(false);
    expect(isRefused({ char: 'i', offset: 5, undone: false }, 'i', 4)).toBe(false);
    expect(isRefused(null, 'i', 4)).toBe(false);
  });
});
