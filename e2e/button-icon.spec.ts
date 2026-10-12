import { test, expect, openApp } from './fixtures';

// Иконка и подпись в Button — на одной линии. До 1.44.1 у Button не было flex:
// svg по preflight Tailwind — display:block и вставал над текстом («Очистить
// день» в журнале цикла: корзина сверху слева, надпись под ней по центру).
test('Button: иконка и подпись «Очистить день» на одной линии', async ({ page }) => {
  await openApp(page, '/more/cycle');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const repo = await import('/src/lib/cycle/cycleRepo.ts');
    const { todayKey } = await import('/src/lib/dates.ts');
    const ts = new Date().toISOString();
    await repo.ensureCycleSetup();
    // «Очистить день» есть только у дня с отметкой.
    await db.cycleDays.put({
      date: todayKey(), note: 'Голова', bleeding: 'medium', isBleedingDay: 1, symptomKeys: [],
      createdAt: ts, updatedAt: ts, source: 'user',
    } as never);
    await repo.rebuildCycles();
  });
  await page.getByRole('button', { name: 'Отметить', exact: true }).click();
  const clear = page.getByRole('button', { name: 'Очистить день' });
  await expect(clear).toBeVisible();

  const { icon, label } = await clear.evaluate((el) => {
    const text = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const box = (r: DOMRect) => ({ top: Math.round(r.top), bottom: Math.round(r.bottom) });
    return { icon: box(el.querySelector('svg')!.getBoundingClientRect()), label: box(range.getBoundingClientRect()) };
  });
  expect(
    icon.bottom > label.top && label.bottom > icon.top,
    `иконка ${icon.top}–${icon.bottom}px, подпись ${label.top}–${label.bottom}px по вертикали`,
  ).toBe(true);
});
