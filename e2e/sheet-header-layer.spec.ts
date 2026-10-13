import { test, expect, openApp } from './fixtures';

// Крестик очистки поля не проступает поверх шапки шторки.
//
// Шапка шторки липкая, крестик в поле — абсолютный, и оба стояли на z-10 в
// одном контексте наложения (панель с transform). При равных z выше рисуется
// то, что позже в DOM, — крестик. Прокрутил форму, поле ушло под шапку, а «×»
// висит поверх заголовка «Новая тренировка» и забирает нажатия по шапке.
// Так было в каждой шторке с заполненным полем: тренировка, задача, место.

test('крестик поля, ушедший под шапку шторки, не перекрывает её', async ({ page }) => {
  await openApp(page, '/more/health');
  await page.getByRole('button', { name: 'Отметить тренировку' }).click();
  // Второй вид даёт форме высоту, чтобы было куда прокрутить.
  await page.getByRole('button', { name: 'Добавить ещё вид', exact: true }).click();
  // «Минут» первого вида заполнено сразу (30) — крестик показан.
  const clear = page.getByRole('button', { name: 'Очистить поле' }).first();
  await expect(clear).toBeVisible();

  const r = await clear.evaluate(async (el) => {
    const panel = el.closest('.overflow-y-auto') as HTMLElement;
    await Promise.all(panel.getAnimations().map((a) => a.finished));
    const header = panel.firstElementChild as HTMLElement;
    const b = el.getBoundingClientRect();
    const h = header.getBoundingClientRect();
    // Центр крестика — на середину шапки.
    panel.scrollTop += b.top + b.height / 2 - (h.top + h.height / 2);
    const c = el.getBoundingClientRect();
    const y = c.top + c.height / 2;
    const at = document.elementFromPoint(c.left + c.width / 2, y);
    return { covered: y > h.top && y < h.bottom, hitClear: at === el, hitHeader: header.contains(at) };
  });

  // Без этого тест прошёл бы впустую, если форме не хватило высоты прокрутки.
  expect(r.covered).toBe(true);
  expect(r.hitClear).toBe(false);
  expect(r.hitHeader).toBe(true);
});
