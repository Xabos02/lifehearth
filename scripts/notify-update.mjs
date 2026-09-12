#!/usr/bin/env node
// Рассылка push-уведомления «вышло обновление» всем подписанным устройствам.
//
// Текст берётся из src/lib/changelog.ts — того же места, откуда его читает окно
// «Что нового» внутри приложения. Раньше текст набирался руками прямо в вызове
// эндпоинта, и он спокойно расходился с тем, что на самом деле поменялось:
// человек получал уведомление про одно, а в приложении видел другое.
//
// Запуск:
//   UPDATE_TOKEN=... node scripts/notify-update.mjs           — разослать
//   UPDATE_TOKEN=... node scripts/notify-update.mjs --dry-run — показать текст
//
// Токен лежит в секретах воркера (wrangler secret list). В репозиторий он не
// попадает и в аргументах командной строки не передаётся: аргументы видны в
// списке процессов любому пользователю системы.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const WORKER_URL = 'https://life-hub-push.xabos161rus.workers.dev';
const here = dirname(fileURLToPath(import.meta.url));

/** Читаем changelog как текст и достаём первый выпуск.
 *
 *  Разбором исходника, а не импортом: файл на TypeScript, и ради одного списка
 *  поднимать сборку скрипту незачем. Формат простой и стабильный — если он
 *  изменится, скрипт упадёт с внятной ошибкой, а не пришлёт пустое письмо. */
function firstRelease() {
  const src = readFileSync(resolve(here, '../src/lib/changelog.ts'), 'utf8');
  const version = src.match(/version:\s*'([^']+)'/)?.[1];
  const date = src.match(/date:\s*'([^']+)'/)?.[1];
  const itemsBlock = src.match(/items:\s*\[([\s\S]*?)\n\s{4}\]/)?.[1];
  if (!version || !itemsBlock) {
    throw new Error('Не удалось разобрать src/lib/changelog.ts — проверьте формат RELEASES');
  }
  const items = [...itemsBlock.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) =>
    m[1].replace(/\\'/g, "'"),
  );
  if (items.length === 0) throw new Error('В первом выпуске нет ни одного пункта');
  return { version, date, items };
}

/** Тот же расчёт, что в pushTextFor (src/lib/changelog.ts): набираем пункты
 *  целиком, пока влезают; не влез даже первый — режем по границе слова. */
function pushText(items, limit = 140) {
  const out = [];
  for (const item of items) {
    if ([...out, item].join('; ').length > limit) break;
    out.push(item);
  }
  if (out.length > 0) return out.join('; ');

  const first = items[0] ?? '';
  if (first.length <= limit) return first;
  const cut = first.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

const release = firstRelease();
const body = pushText(release.items);
const dryRun = process.argv.includes('--dry-run');

console.log(`Версия ${release.version} (${release.date ?? 'без даты'})`);
console.log(`Пунктов в выпуске: ${release.items.length}`);
console.log(`Текст уведомления (${body.length} симв.):\n  ${body}\n`);

if (dryRun) {
  console.log('Пробный запуск — ничего не отправлено.');
  process.exit(0);
}

const token = process.env.UPDATE_TOKEN;
if (!token) {
  console.error('Нет UPDATE_TOKEN в переменных окружения. Отправка отменена.');
  process.exit(1);
}

const res = await fetch(`${WORKER_URL}/notify-update`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  // Версия уходит вместе с текстом: воркер помнит, о какой уже рассылал, и
  // на повторный вызов с той же версией отвечает skipped — поэтому CI может
  // звать скрипт после каждого удачного деплоя, не решая сам, менялась ли она.
  body: JSON.stringify({ body, version: release.version }),
});

if (!res.ok) {
  console.error(`Воркер ответил ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const data = await res.json();
if (data.skipped === 'same-version') {
  console.log(`Об этой версии уже рассылали — пропуск.`);
} else {
  console.log(`Отправлено устройствам: ${data.sent}`);
}
