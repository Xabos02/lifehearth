import { test, expect, openApp } from './fixtures';

// Шкала кеглей и радиусов держится тестом, а не договорённостью.
//
// Разъехалось всё это не от небрежности: шкалы просто не было, и где не
// хватало ступени — ставили произвольное значение. Набралось 24 кегля и 10
// радиусов. Если не проверять машинно, следующая правка вернёт всё обратно
// ровно тем же путём.

const SCREENS = ['/', '/tasks', '/notes', '/calendar', '/goals', '/stats', '/home',
  '/more/finance', '/more/focus', '/more/habits', '/more/learning', '/more/energy',
  '/more/places', '/more/family', '/more/cycle', '/more/settings',
  '/more/health'];

// Значения при базовых 17px. Заголовок экрана — clamp, поэтому попадает в
// диапазон 23–27 и перечислен отдельно.
const SIZES = new Set([
  11, 13, 15, 17, 20, 26, 32, 48,
  // 16px — поля ввода. Не ступень шкалы, а обход поведения iOS: Safari
  // зумит страницу при фокусе в поле с кеглем меньше 16. Правило живёт в
  // index.css вне слоёв и намеренно перебивает утилиты.
  16,
]);
// Радиусы стали целыми вместе с сеткой: пока шаг Tailwind считался в rem при
// корне 17px, каждый из них был дробным (8.5, 12.75, 17, 25.5) и давал разную
// видимую толщину хайрлайна на DPR 3. Токены переопределены в @theme.
const RADII = new Set([
  0, 4, 6, 8, 12, 16,
  // 24 — геройская иконка вводного экрана и семейного, 80×80. Элемент такого
  // масштаба в приложении один, пары у него нет.
  24,
  // 27.2 — верх нижнего шита, задан произвольным значением, а не ступенью.
  27.2,
]);

test('кегли и радиусы — только из шкалы', async ({ page }) => {
  await openApp(page);
  const bad = new Map<string, string>();
  for (const path of SCREENS) {
    await page.evaluate((p) => {
      history.pushState({}, '', p);
      dispatchEvent(new PopStateEvent('popstate'));
    }, path);
    await page.waitForTimeout(400);
    const found = await page.evaluate(
      ({ sizes, radii }) => {
        const out: { key: string; text: string }[] = [];
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const cs = getComputedStyle(el);
          const cls = (el.getAttribute('class') || '').slice(0, 60);
          const size = Math.round(parseFloat(cs.fontSize) * 100) / 100;
          // Заголовок экрана масштабируется по ширине окна — у него диапазон.
          const isTitle = el.tagName === 'H1';
          if (!isTitle && !sizes.some((s) => Math.abs(s - size) < 0.6)) {
            out.push({ key: `кегль ${size}`, text: `${size}px — ${cls}` });
          }
          for (const corner of [cs.borderTopLeftRadius, cs.borderBottomRightRadius]) {
            const v = parseFloat(corner);
            if (!Number.isFinite(v) || corner.includes('%')) continue;
            // rounded-full Chromium отдаёт как гигантское число, а не как
            // половину стороны — сравнение «примерно половина» его не ловило.
            const round = v >= Math.min(r.width, r.height) / 2 - 1.5;
            if (!round && !radii.some((x) => Math.abs(x - v) < 0.6)) {
              out.push({ key: `радиус ${v}`, text: `${v}px — ${cls}` });
            }
          }
        }
        return out;
      },
      { sizes: [...SIZES], radii: [...RADII] },
    );
    for (const f of found) if (!bad.has(f.key)) bad.set(f.key, `${path}: ${f.text}`);
  }
  expect([...bad.values()], `значений вне шкалы: ${bad.size}`).toEqual([]);
});
