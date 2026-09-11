import { test, expect, openApp } from './fixtures';

// Счётчик задач у проекта — в цвет проекта, но только в тёмной теме.
//
// Решение владельца от 11.09.2026, выбрано на канве из трёх вариантов.
// В светлой теме голая цветная цифра проваливает AA для всех 27 цветов
// палитры (замер: лучший 4,45 при норме 4,5), поэтому там остаётся серый.
// Оба поведения — намеренные; тест держит оба, чтобы «починить» одно из них
// нельзя было незаметно.

async function seed(page: import('@playwright/test').Page, extra: Record<string, unknown> = {}) {
  await page.evaluate(async (extraSettings) => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    await db.projects.bulkPut([
      { id: 'p1', name: 'ИИ', color: '#f59e0b', emoji: '📁', parentId: null, sortOrder: 1, archivedAt: null, createdAt: ts, updatedAt: ts, deletedAt: null },
      { id: 'p2', name: 'Разработка', color: '#ef4444', emoji: '📁', parentId: 'p1', sortOrder: 2, archivedAt: null, createdAt: ts, updatedAt: ts, deletedAt: null },
    ] as never[]);
    const prev = (await db.settings.get('app')) ?? { id: 'app' };
    await db.settings.put({ ...prev, id: 'app', ...extraSettings } as never);
  }, extra);
  await page.reload();
  await expect(page.getByText('Разработка')).toBeVisible();
}

function countColorOf(page: import('@playwright/test').Page, projectName: string) {
  return page.evaluate((name) => {
    const h = [...document.querySelectorAll('h2, h3, span')].find((el) => el.textContent?.trim() === name)!;
    const count = h.parentElement!.querySelector('.project-count') as HTMLElement;
    return getComputedStyle(count).color;
  }, projectName);
}

test('тёмная тема: цифра в цвете проекта — у проекта и у подпроекта', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page);
  expect(await countColorOf(page, 'ИИ')).toBe('rgb(245, 158, 11)');
  expect(await countColorOf(page, 'Разработка')).toBe('rgb(239, 68, 68)');
});

test('светлая тема: цифра остаётся серой — цветная не читается', async ({ page }) => {
  await openApp(page, '/tasks');
  await seed(page, { theme: 'light' });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('light'))).toBe(true);
  const c = await countColorOf(page, 'ИИ');
  expect(c).not.toBe('rgb(245, 158, 11)');
  // Тот же цвет, что у прочего приглушённого текста.
  const muted = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-muted').trim());
  expect(muted.length).toBeGreaterThan(0);
});
