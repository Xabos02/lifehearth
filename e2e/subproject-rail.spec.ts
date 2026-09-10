import { test, expect, openApp } from './fixtures';

// Направляющая подпроекта: полоса в цвет проекта с загнутыми концами.
//
// Загибы здесь НАМЕРЕННЫЕ — решение владельца от 10.09.2026. Граница только
// левая, радиус стоит на всех четырёх углах, и браузер загибает её концы
// вправо. Со стороны это легко принять за дефект: у свёрнутого подпроекта
// высота около 44px, два радиуса по 16px съедают 32, и полоса вырождается в
// скобку. Владельцу показали три варианта рядом — загибы 16px, прямая
// вертикаль, мягкий изгиб 8px, — он выбрал первый.
//
// Тест стоит именно поэтому: без него следующий разбор снова предложит
// «выпрямить», и правку примут как исправление вёрстки.

test('полоса загнута слева, справа углы прямые — так выбрал владелец', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    await db.projects.bulkPut([
      { id: 'p1', name: 'Бизнес', color: '#5b7cfa', emoji: '📁', parentId: null, sortOrder: 1, archivedAt: null, createdAt: ts, updatedAt: ts, deletedAt: null },
      { id: 'p2', name: 'Разработка', color: '#ef4444', emoji: '📁', parentId: 'p1', sortOrder: 2, archivedAt: null, createdAt: ts, updatedAt: ts, deletedAt: null },
    ] as never[]);
  });
  await page.reload();
  await expect(page.getByText('Разработка')).toBeVisible();

  const rail = await page.evaluate(() => {
    const el = document.querySelector('[data-sub-of="p1"]') as HTMLElement;
    const s = getComputedStyle(el);
    return {
      leftWidth: s.borderLeftWidth,
      leftColor: s.borderLeftColor,
      topLeft: s.borderTopLeftRadius,
      bottomLeft: s.borderBottomLeftRadius,
      topRight: s.borderTopRightRadius,
      bottomRight: s.borderBottomRightRadius,
    };
  });

  // Полоса на месте и покрашена цветом проекта.
  expect(rail.leftWidth).toBe('2px');
  expect(rail.leftColor).toBe('rgb(239, 68, 68)');
  // Концы полосы загнуты — 16px, вариант «А» из трёх показанных владельцу.
  expect(rail.topLeft).toBe('16px');
  expect(rail.bottomLeft).toBe('16px');
  // А справа скруглений нет: там ничего не нарисовано, но углы всё равно
  // проступали еле заметными дугами на экране владельца.
  expect(rail.topRight).toBe('0px');
  expect(rail.bottomRight).toBe('0px');
});
