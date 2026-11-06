import { describe, it, expect } from 'vitest';
import { splitByAddress, hasAddress, hrefFor } from './linkify';

/** Текст с подсветкой адресов — так короче сравнивать. */
function marked(text: string): string {
  return splitByAddress(text)
    .map((p) => (p.href ? `[${p.text}](${p.href})` : p.text))
    .join('');
}

describe('адрес узнаётся', () => {
  it('с протоколом', () => {
    expect(marked('смотри https://ozon.ru/product/kabel дешевле'))
      .toBe('смотри [https://ozon.ru/product/kabel](https://ozon.ru/product/kabel) дешевле');
  });

  it('без протокола, если зона из списка', () => {
    expect(marked('поставщик vk.com/market/kabel-opt'))
      .toBe('поставщик [vk.com/market/kabel-opt](https://vk.com/market/kabel-opt)');
  });

  it('с www и незнакомой зоной', () => {
    expect(marked('www.example.xyz')).toBe('[www.example.xyz](https://www.example.xyz)');
  });

  it('почта целиком, а не хвост домена', () => {
    expect(marked('счёт на buh@zavod-sv.ru'))
      .toBe('счёт на [buh@zavod-sv.ru](mailto:buh@zavod-sv.ru)');
  });

  it('несколько адресов в строке', () => {
    expect(marked('vk.com и ozon.ru'))
      .toBe('[vk.com](https://vk.com) и [ozon.ru](https://ozon.ru)');
  });
});

describe('адресом НЕ считается', () => {
  // Главная опасность затеи: деловая заметка полна слов с точкой внутри.
  // Загорись они золотом — список дел стал бы минным полем.
  it.each([
    'отчёт.pdf',
    'счёт-фактура.docx',
    'смета.xlsx',
    'ст.3 п.2 договора',
    'итого.Всего 12 000',
    'версия 1.50.0',
    'ООО «Кабель.Про»',
  ])('%s', (text) => {
    expect(hasAddress(text), text).toBe(false);
  });
});

describe('границы адреса', () => {
  it('запятая после адреса остаётся предложению', () => {
    expect(marked('зайди на vk.com/market, там дешевле'))
      .toBe('зайди на [vk.com/market](https://vk.com/market), там дешевле');
  });

  it('точка в конце предложения не съедается', () => {
    expect(marked('смотрел на ozon.ru.')).toBe('смотрел на [ozon.ru](https://ozon.ru).');
  });

  it('адрес в скобках не забирает закрывающую', () => {
    expect(marked('(см. vk.com/market)')).toBe('(см. [vk.com/market](https://vk.com/market))');
  });
});

describe('регистр домена', () => {
  // Первую букву строки редактор поднимает сам (autocapitalize), и адрес с
  // новой строки приезжал бы «Vk.com/market» со ссылкой на «https://Vk.com».
  it('домен опускается в строчные, путь — нет', () => {
    expect(marked('Vk.com/Market/Kabel'))
      .toBe('[vk.com/Market/Kabel](https://vk.com/Market/Kabel)');
  });

  it('схема тоже строчными', () => {
    expect(marked('HTTPS://Ozon.ru/Product'))
      .toBe('[https://ozon.ru/Product](https://ozon.ru/Product)');
  });

  it('у почты имя до @ не трогаем', () => {
    expect(marked('Buh@Zavod-SV.ru')).toBe('[Buh@zavod-sv.ru](mailto:Buh@zavod-sv.ru)');
  });

  it('длина не меняется — каретка в редакторе не уедет', () => {
    const src = 'Vk.com/Market';
    expect(splitByAddress(src).map((p) => p.text).join('')).toHaveLength(src.length);
  });
});

describe('href', () => {
  it('протокол сохраняется как есть', () => {
    expect(hrefFor('http://vk.com')).toBe('http://vk.com');
  });
  it('домену дописывается https', () => {
    expect(hrefFor('vk.com')).toBe('https://vk.com');
  });
  it('почте дописывается mailto', () => {
    expect(hrefFor('buh@zavod.ru')).toBe('mailto:buh@zavod.ru');
  });
});
