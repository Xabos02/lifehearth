import fs from 'node:fs';
import type { Download, Page } from '@playwright/test';
import { test, expect, openApp } from './fixtures';

// ST4 аудита 1.64.0: код на «Женских днях» обходился двумя тапами —
// «Настройки → Копии → Сохранить в файл» отдавала записи раздела открытым
// текстом, код не спрашивался. Теперь перед копией файлом — окно кода, а кто
// код не знает, сохраняет копию без раздела (канва design/backup-pin, Б).

const NOTE = 'личная заметка о цикле';

async function seedLocked(page: Page, opts: { includeInGeneralBackup?: boolean } = {}) {
  await page.evaluate(
    async ({ note, include }) => {
      const repo = await import('/src/lib/cycle/cycleRepo.ts');
      const { hashPin } = await import('/src/lib/crypto.ts');
      await repo.ensureCycleSetup();
      await repo.putDay('2026-11-10', { bleeding: 'medium', note });
      await repo.updateCycleSettings({ lock: 'pin', pin: await hashPin('1234'), includeInGeneralBackup: include });
    },
    { note: NOTE, include: opts.includeInGeneralBackup ?? true },
  );
}

async function fileOf(d: Download): Promise<{ data: Record<string, unknown[]> }> {
  return JSON.parse(fs.readFileSync((await d.path())!, 'utf8'));
}

test.beforeEach(async ({ page }) => {
  // Профиль iPhone ведёт копию в шит «Поделиться»; в Chromium его нет —
  // убираем canShare, и копия идёт обычным скачиванием, которое видно тесту.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'canShare', { value: undefined, configurable: true });
  });
});

test('закрытый раздел: без кода файла нет, без раздела — файл без его ключей, с кодом — целиком', async ({ page }) => {
  await openApp(page, '/more/settings/backup');
  await seedLocked(page);
  await page.reload();

  let downloads = 0;
  page.on('download', () => downloads++);
  const save = page.getByRole('button', { name: 'Сохранить в файл' });
  const sheetTitle = page.getByRole('heading', { level: 2, name: 'Нужен код' });

  // Тап по «Сохранить в файл» — сначала окно кода, файла нет. Раздел окно не
  // называет: его спрятанность — тоже информация.
  await save.click();
  await expect(sheetTitle).toBeVisible();
  await expect(page.locator('[class*="rounded-t-"]').filter({ has: sheetTitle })).not.toContainText('Женск');

  // Неверный код — ошибка, файла по-прежнему нет.
  await page.getByLabel('Код доступа').fill('0000');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Неверный код. Попробуйте ещё раз');
  expect(downloads).toBe(0);

  // Без кода — копия без раздела: ключей cycle* нет вовсе (пустые массивы
  // стёрли бы историю цикла при восстановлении), остальное на месте.
  const [without] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Сохранить без закрытых записей' }).click(),
  ]);
  const partial = await fileOf(without);
  expect(Object.keys(partial.data).filter((k) => k.startsWith('cycle'))).toEqual([]);
  expect(partial.data.notes).toBeDefined();
  expect(JSON.stringify(partial)).not.toContain(NOTE);
  await expect(page.getByText('Резервная копия сохранена без закрытых записей')).toBeVisible();
  await expect(sheetTitle).toBeHidden();

  // Раздел по-прежнему закрыт — снова окно; верный код отдаёт копию целиком.
  await save.click();
  await expect(sheetTitle).toBeVisible();
  await page.getByLabel('Код доступа').fill('1234');
  const [full] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Сохранить', exact: true }).click(),
  ]);
  expect(JSON.stringify((await fileOf(full)).data.cycleDays)).toContain(NOTE);

  // Код введён — раздел открыт до перезагрузки, как после экрана замка:
  // следующая копия окна не показывает.
  const [again] = await Promise.all([page.waitForEvent('download'), save.click()]);
  expect(JSON.stringify((await fileOf(again)).data.cycleDays)).toContain(NOTE);
  await expect(sheetTitle).toBeHidden();
});

test('раздел без кода или выключенный из копий — файл сразу, без окна', async ({ page }) => {
  await openApp(page, '/more/settings/backup');
  // Код стоит, но раздел из копий выключен — в файл он не попадает,
  // спрашивать нечего.
  await seedLocked(page, { includeInGeneralBackup: false });
  await page.reload();

  const [d] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Сохранить в файл' }).click(),
  ]);
  expect(JSON.stringify(await fileOf(d))).not.toContain(NOTE);
  await expect(page.getByRole('heading', { level: 2, name: 'Нужен код' })).toHaveCount(0);
});
