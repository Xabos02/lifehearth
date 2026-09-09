import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Сторож маршрутов: если инструкция говорит «Настройки → Копии и
// восстановление → Сохранить в файл», то каждый её шаг обязан быть настоящей
// подписью на экране.
//
// Зачем. Шесть инструкций в приложении вели по пунктам меню, которых нет:
// «Настройки → Данные → Экспортировать резервную копию» — при том, что раздел
// называется «Копии и восстановление», а кнопка «Сохранить в файл». Читает их
// человек, который уже в беде: переставляет приложение или ищет свои данные на
// новом телефоне. Он не находит пункта и решает, что данные потеряны.
//
// Ломается это молча и при любом переименовании кнопки — то есть будет
// ломаться и дальше, если не держать проверку.

const SRC = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

const files = walk(SRC);
const all = files.map((f) => readFileSync(f, 'utf8'));

/** Подписи, которые приложение реально показывает.
 *
 *  Источник — только экраны (.tsx). Словарь переводов сюда НЕ входит, и это
 *  главное: в нём годами лежат ключи снятых экранов («Экспортировать резервную
 *  копию» жила там после того, как кнопка стала «Сохранить в файл»), и сторож,
 *  видевший словарь, признавал живым любой мёртвый маршрут. Проверено
 *  мутацией: со словарём в источниках подсунутая ошибка не ловилась. */
const labels = new Set<string>();
files.forEach((file, i) => {
  if (!file.endsWith('.tsx')) return;
  const src = all[i];
  for (const m of src.matchAll(/t\(\s*'((?:[^'\\]|\\.)+)'/g)) labels.add(m[1].replace(/\\'/g, "'"));
  for (const m of src.matchAll(/t\(\s*"((?:[^"\\]|\\.)+)"/g)) labels.add(m[1].replace(/\\"/g, '"'));
});

/** Шаг маршрута считается известным, если такая подпись где-то есть.
 *  Сравниваем по началу: подпись на кнопке бывает длиннее шага
 *  («У меня уже есть данные — подключить по ключу»). */
function known(step: string): boolean {
  const s = step.trim().replace(/^[«"']|[»"'.]$/g, '').trim();
  if (!s) return true;
  for (const l of labels) {
    const clean = l.replace(/[«»"']/g, '');
    if (clean === s || clean.startsWith(s) || s.startsWith(clean)) return true;
  }
  return false;
}

describe('маршруты в инструкциях', () => {
  it('каждый шаг вида «Настройки → …» существует как подпись на экране', () => {
    const broken: string[] = [];
    files.forEach((file, i) => {
      // changelog — исторический документ: записи прошлых выпусков люди уже
      // прочитали, переписывать их задним числом нельзя.
      if (file.endsWith('changelog.ts')) return;
      for (const m of all[i].matchAll(/Настройки\s*→[^'"`\n]*/g)) {
        const steps = m[0].split('→').slice(1);
        for (const step of steps) {
          const s = step.replace(/[»"'.].*$/, '').trim();
          // Со строчной буквы начинается продолжение фразы, а не пункт меню:
          // «…→ „У меня уже есть данные“» → вставьте сохранённый ключ». Все
          // подписи в приложении начинаются с заглавной.
          if (!s || /^[а-яё]/.test(s)) continue;
          if (!known(s)) broken.push(`${file.replace(SRC, 'src')}: «${s}»`);
        }
      }
    });
    expect(broken, `шагов в никуда: ${broken.length}`).toEqual([]);
  });
});
