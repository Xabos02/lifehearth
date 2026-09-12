import { test, expect, openApp } from './fixtures';
import type { Page } from '@playwright/test';

// Контраст текста и иконок — по пикселям в живом браузере.
//
// Проверять таблицу токенов бесполезно: она показывает потенциал, а не факт.
// Один и тот же цвет лежит на трёх поверхностях и на собственной подложке, и
// на каждой контраст свой. Плюс кнопки залиты градиентом — там backgroundColor
// прозрачный, и «цвет фона» приходится брать из стопов.
//
// Два подводных камня, на которых первая версия этой проверки врала:
//  — getComputedStyle отдаёт цвет строкой 'oklch(0.7 0.185 20)', и наивный
//    парсер читает три числа как RGB. Считаем через canvas: он разворачивает
//    любой CSS-цвет в те пиксели, которые видит человек;
//  — фон надо брать с САМОГО элемента, а не с родителя, иначе у кнопки
//    находится фон карточки под ней.
// Отсюда самопроверка ниже: белое на чёрном обязано дать 21.

const SCREENS = ['/', '/tasks', '/notes', '/calendar', '/goals', '/stats', '/home',
  '/more/finance', '/more/focus', '/more/habits', '/more/learning', '/more/energy',
  '/more/places', '/more/family', '/more/cycle', '/more/settings',
  '/more/health'];

interface Finding { что: string; класс: string; контраст: number; нужно: number }

async function scan(page: Page): Promise<Finding[]> {
  return page.evaluate(() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    const px = (css: string): number[] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return +((x + 0.05) / (y + 0.05)).toFixed(2);
    };
    if (ratio([0, 0, 0], [255, 255, 255]) !== 21) throw new Error('замер контраста сломан');

    const over = (fg: number[], bg: number[]) =>
      [0, 1, 2].map((i) => Math.round(fg[i] * fg[3] + bg[i] * (1 - fg[3])));
    const stops = (img: string) =>
      (img && img !== 'none'
        ? (img.match(/(?:rgba?|oklch|oklab|hsla?)\([^)]*\)|#[0-9a-f]{3,8}/gi) || [])
        : []
      ).map(px).filter((c) => c[3] > 0);
    const bgOf = (el: Element): number[][] => {
      const stack: number[][] = [];
      let grad: number[][] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        const g = stops(cs.backgroundImage);
        if (g.length) { grad = g; break; }
        const c = px(cs.backgroundColor);
        if (c[3] > 0) stack.push(c);
        if (c[3] >= 0.999) break;
      }
      const bases = grad.length ? grad : [[14, 14, 21, 1]];
      return bases.map((base) => {
        let out = [base[0], base[1], base[2]];
        for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
        return out;
      });
    };

    const found: Finding[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const ownText = [...el.childNodes]
        .filter((n) => n.nodeType === 3).map((n) => n.textContent!.trim()).join('');
      const isIcon = el.tagName === 'svg';
      if (!ownText && !isIcon) continue;
      const fg = px(isIcon ? (cs.stroke !== 'none' ? cs.stroke : cs.color) : cs.color);
      const c = Math.min(...bgOf(el).map((bg) => ratio(over(fg, bg), bg)));
      const size = parseFloat(cs.fontSize) || 17;
      const bold = Number(cs.fontWeight) >= 600;
      // Пороги WCAG AA: 3.0 для крупного текста и графики, 4.5 для обычного.
      const need = isIcon || size >= 24 || (bold && size >= 19) ? 3 : 4.5;
      if (c < need) {
        found.push({
          что: (isIcon ? `иконка ${el.getAttribute('class') ?? ''}` : ownText).slice(0, 40),
          класс: (el.getAttribute('class') || '').slice(0, 70),
          контраст: c, нужно: need,
        });
      }
    }
    return found;
  });
}

// Акцентные темы меняют только акцентные токены, поэтому их прогон короче:
// экраны, где акцент представлен всеми ролями — текстом, заливкой кнопок,
// чипами, Fab и градиентом шапки. Дефолтный индиго проверяется по всем
// экранам, как раньше.
const ACCENT_SCREENS = ['/', '/tasks', '/notes', '/goals', '/home', '/more/settings'];

async function auditScreens(
  page: Page,
  theme: 'dark' | 'light',
  accent: string,
  screens: string[],
): Promise<string[]> {
  await page.evaluate(
    ({ t, a }) => {
      document.documentElement.classList.toggle('light', t === 'light');
      if (a === 'indigo') delete document.documentElement.dataset.accent;
      else document.documentElement.dataset.accent = a;
    },
    { t: theme, a: accent },
  );
  const bad: string[] = [];
  for (const path of screens) {
    // Переход внутри приложения, без перезагрузки: она сбросила бы класс темы,
    // и «светлая» проверялась бы вхолостую.
    await page.evaluate((p) => {
      history.pushState({}, '', p);
      dispatchEvent(new PopStateEvent('popstate'));
    }, path);
    await page.waitForTimeout(400);
    for (const f of await scan(page)) {
      bad.push(`${path} — «${f.что}» ${f.контраст}:1 (нужно ${f.нужно}) [${f.класс}]`);
    }
  }
  return bad;
}

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: контраст текста и иконок не ниже AA`, async ({ page }) => {
    await openApp(page);
    const bad = await auditScreens(page, theme, 'indigo', SCREENS);
    expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
  });

  for (const accent of ['emerald', 'sunset'] as const) {
    test(`${theme} + ${accent}: акцентная палитра не роняет контраст`, async ({ page }) => {
      await openApp(page);
      const bad = await auditScreens(page, theme, accent, ACCENT_SCREENS);
      expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
    });
  }
}

// Карточка обязана отличаться от фона под ней.
//
// Проверки выше меряют текст на поверхности. А поверхность может слиться с
// фоном, и тогда текст читается, но списка как предмета на экране нет: строки
// висят в пустоте. Так и было — 1.09:1 между карточкой и фоном, то есть
// граница существовала только в разметке.
//
// Порог 1.12 — не идеал, а нижняя граница «видно, что это карточка». Ставить
// выше нельзя произвольно: светлее фон под светлым текстом означает меньше
// контраст самого текста, и это уже разговор с владельцем, а не правка.
test('тёмная тема: карточка отличается от фона', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.put({ ...base('c1'), name: 'Дела', color: '#5b7cfa', emoji: '📁', sortOrder: 1000, archivedAt: null } as never);
    await db.tasks.put({
      ...base('ct1'), title: 'Задача', notes: '', projectId: 'c1', goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: 1000,
    } as never);
  });
  await page.goto('/tasks');
  await expect(page.getByText('Задача', { exact: true }).first()).toBeVisible();

  const ratio = await page.evaluate(() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    // Через canvas: getComputedStyle отдаёт oklch(...), и наивный разбор читал
    // бы три числа как RGB.
    const lum = (css: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      const ch = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const card = document.querySelector('.card');
    if (!card) throw new Error('карточки на экране нет — проверять нечего');
    const cardBg = getComputedStyle(card).backgroundColor;
    // Подложку ищем ВВЕРХ по предкам до первого непрозрачного фона, а не берём
    // с body: у body намеренно стоит цвет таб-бара (он виден только в зазорах
    // safe-area), а сам экран рисует каркас приложения. Замер по body показывал
    // 1.01:1 и говорил про несуществующую пару цветов.
    let node: HTMLElement | null = card.parentElement;
    let pageBg = 'rgb(0, 0, 0)';
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && !/rgba?\(0, 0, 0, 0\)|transparent/.test(bg)) {
        pageBg = bg;
        break;
      }
      node = node.parentElement;
    }
    const a = lum(cardBg);
    const b = lum(pageBg);
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  });

  expect(ratio, `карточка сливается с фоном: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(1.12);
});
