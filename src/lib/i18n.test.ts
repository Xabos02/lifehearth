import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLang, resolveLang, setLang, t, tPlur, tPlural } from './i18n';

afterEach(() => setLang('ru'));

describe('локализация', () => {
  it('русский — исходный: t возвращает ключ как есть', () => {
    setLang('ru');
    expect(t('Сохранить')).toBe('Сохранить');
  });

  it('английский берётся из словаря по русскому ключу', () => {
    setLang('en');
    expect(t('Сохранить')).toBe('Save');
    expect(t('Настройки')).toBe('Settings');
  });

  it('непереведённая строка честно падает в русский', () => {
    setLang('en');
    expect(t('Строки-которой-нет-в-словаре')).toBe('Строки-которой-нет-в-словаре');
  });

  it('подстановки работают в обоих языках', () => {
    setLang('ru');
    expect(t('Версия {v}', { v: '1.5.0' })).toBe('Версия 1.5.0');
    setLang('en');
    expect(t('Версия {v}', { v: '1.5.0' })).toBe('Version 1.5.0');
  });

  it('долларовые паттерны в значении подстановки не интерпретируются', () => {
    // replaceAll со строковой заменой трактует $$ / $& / $` / $' как
    // спецпаттерны — имя «Ba$$» исказилось бы. Замена идёт функцией.
    expect(t('{name} присоединился', { name: 'Ba$$ Boy' })).toBe('Ba$$ Boy присоединился');
    expect(t('{name} присоединился', { name: '$&' })).toBe('$& присоединился');
  });

  it('склонение: русские формы против английской пары', () => {
    setLang('ru');
    expect(tPlur(2, ['задача', 'задачи', 'задач'])).toBe('2 задачи');
    setLang('en');
    expect(tPlur(1, ['задача', 'задачи', 'задач'])).toBe('1 task');
    expect(tPlur(5, ['задача', 'задачи', 'задач'])).toBe('5 tasks');
    // Пары нет в словаре — русский fallback, а не пустота.
    expect(tPlural(3, ['кот', 'кота', 'котов'])).toBe('кота');
  });

  it('resolveLang: явная настройка сильнее системы, без настройки — система', () => {
    expect(resolveLang('en')).toBe('en');
    expect(resolveLang('ru')).toBe('ru');
    vi.stubGlobal('navigator', { language: 'ru-RU' });
    expect(resolveLang(undefined)).toBe('ru');
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(resolveLang(undefined)).toBe('en');
    vi.unstubAllGlobals();
    expect(getLang()).toBe('ru');
  });
});
