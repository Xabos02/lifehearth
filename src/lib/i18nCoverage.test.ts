import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EN } from './i18n/en';

// Каждая строка интерфейса обязана иметь английский перевод.
//
// Русский — исходный язык: непереведённый ключ не ломает приложение, он просто
// показывается по-русски. Поэтому утечка не видна ничем — ни падением, ни
// ошибкой в консоли, — и обнаруживается только тем, кто переключил язык.
// К моменту, когда сторож появился, так протекло полтора десятка строк, включая
// вкладку задач семейного раздела: ею пользуются другие люди.
//
// Две ловушки, из-за которых наивный сторож даёт ложное спокойствие.
// Первая: ключи живут не только в .tsx — часть лежит в обычных .ts (например
// в lib/family). Вторая: половина ключей раздела задач динамическая —
// t(o.label), t(WEEKDAY_LABELS[i]), t(REC_INTERVAL_LABELS[type]), — и разбор
// одних литералов внутри t(...) их не видит вовсе. Поэтому вторым проходом
// собираются строки из таблиц-констант, из которых эти ключи и берутся.

const SRC = new URL('..', import.meta.url).pathname;

/** Кириллица в строке — признак того, что это ключ интерфейса, а не id/класс. */
const CYRILLIC = /[а-яёА-ЯЁ]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue; // тесты не интерфейс
    if (p.includes(join('lib', 'i18n'))) continue; // сам словарь
    out.push(p);
  }
  return out;
}

/** Развернуть escape-последовательности исходника в настоящие символы.
 *
 *  Без этого сторож сравнивает запись «\\u00A0» с настоящим неразрывным
 *  пробелом в словаре и объявляет отсутствующими ключи, которые давно на
 *  месте: единицы измерения, переносы строк в длинных подтверждениях. Первый
 *  прогон дал двадцать три «пропажи», из которых треть была такой. */
function unescape(raw: string): string {
  const forJson = raw.replace(/\\'/g, "'").replace(/"/g, '\\"');
  try {
    return JSON.parse(`"${forJson}"`) as string;
  } catch {
    return raw;
  }
}

/** Ключи из литеральных вызовов: t('…'), tPlur('…', …). */
function literalKeys(code: string): string[] {
  const out: string[] = [];
  const re = /\bt(?:Plur)?\(\s*'((?:[^'\\]|\\.)*)'/g;
  for (const m of code.matchAll(re)) out.push(unescape(m[1]));
  return out;
}

/** Строки из таблиц-подписей: const X_LABELS = [...] / X_OPTIONS = [...].
 *
 *  Из них ключ приходит в t() переменной, и первый проход его не увидит. */
function tableKeys(code: string): string[] {
  const out: string[] = [];
  const re = /const\s+\w*(?:LABELS|OPTIONS|PRESETS|TITLES)\w*\s*(?::[^=]+)?=\s*([[{][\s\S]*?[\]}]);/g;
  for (const block of code.matchAll(re)) {
    for (const m of block[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)) out.push(unescape(m[1]));
  }
  return out;
}

describe('покрытие английского словаря', () => {
  it('каждая русская строка интерфейса переведена', () => {
    const missing = new Map<string, string>(); // ключ → где нашли
    for (const file of walk(SRC)) {
      const code = readFileSync(file, 'utf8');
      const keys = [...literalKeys(code), ...tableKeys(code)];
      for (const key of keys) {
        if (!CYRILLIC.test(key)) continue;
        if (EN[key] !== undefined) continue;
        if (!missing.has(key)) missing.set(key, file.slice(SRC.length));
      }
    }
    const list = [...missing].map(([key, where]) => `${where}: «${key}»`).sort();
    expect(list, `без английского перевода: ${list.length}`).toEqual([]);
  });

  it('сторож действительно что-то находит, а не молчит на пустом множестве', () => {
    // Страховка от «зелёного по недосмотру»: если разбор перестанет находить
    // ключи (сменился синтаксис, переименовали t), проверка выше станет
    // бессмысленной и при этом останется зелёной.
    const sample = readFileSync(join(SRC, 'features', 'tasks', 'TaskEditSheet.tsx'), 'utf8');
    expect(literalKeys(sample).filter((k) => CYRILLIC.test(k)).length).toBeGreaterThan(10);
    expect(tableKeys(sample).filter((k) => CYRILLIC.test(k)).length).toBeGreaterThan(3);
  });
});

describe('английский словарь — одна система кавычек', () => {
  it('в значениях только “ ”, без прямых " и без « »', async () => {
    const { EN } = await import('./i18n/en');
    const bad = Object.entries(EN)
      .filter(([, v]) => /["«»]/.test(v))
      .map(([k]) => k)
      .sort();
    // Тост после переноса шёл с прямыми кавычками, подпись во время переноса —
    // с типографскими, на одном экране. Норма — типографские: их большинство.
    expect(bad, `значений с прямыми или русскими кавычками: ${bad.length}`).toEqual([]);
  });
});
