import { test, expect, openApp, openFamilyChrome } from './fixtures';
import type { Locator, Page } from '@playwright/test';

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
  '/more/health', '/more/ai'];

// Пустой раздел ИИ не набран индиго ни в одном тексте: пока у светлой темы
// не было своего --lh-ai-accent, текст раздела шёл на 2.65–2.74, а страж на
// пустом разделе был зелёным. Индиговый текст — след инструментов и
// «Дописать» на подложке /15, «Данные» на /12 — появляется только у ответа,
// поэтому ответ засеваем.
async function seedAiReply(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.llmChats.put({
      ...base('ai-c'), title: 'Чат', model: 'm', systemPrompt: '', lastMessageAt: now, dataTools: true,
    } as never);
    await db.llmMessages.put({
      ...base('ai-m'), chatId: 'ai-c', role: 'assistant', content: 'Ответ', model: 'm',
      tokensIn: 1, tokensOut: 1, costRub: 0, status: 'done', error: null,
      finishReason: 'length', toolTrace: [{ tool: 'list_tasks', count: 3 }],
    } as never);
  });
}

interface Finding { что: string; класс: string; контраст: number; нужно: number }

async function scan(page: Page, root = page.locator('body')): Promise<Finding[]> {
  return root.evaluate((rootEl) => {
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
    for (const el of rootEl.querySelectorAll('*')) {
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

async function auditScreens(
  page: Page,
  theme: 'dark' | 'light',
  screens: string[],
): Promise<string[]> {
  await page.evaluate((t) => document.documentElement.classList.toggle('light', t === 'light'), theme);
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
    await seedAiReply(page);
    const bad = await auditScreens(page, theme, SCREENS);
    expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
  });
}

// Правила печати в index.css перекрашивают классы экрана под белый лист. После
// перевода на lh-* они смотрели на старые text-muted / divide-hairline, и
// вторичный текст тёмной темы уходил в «Отчёт для врача» почти белым на белом.
test('печать «Отчёта для врача»: текст читается на белом листе', async ({ page }) => {
  await openApp(page, '/more/cycle/report');
  await expect(page.locator('h1').first()).toHaveText(/Отчёт для врача/);
  await page.emulateMedia({ media: 'print' });
  const bad = (await scan(page)).map((f) => `«${f.что}» ${f.контраст}:1 (нужно ${f.нужно}) [${f.класс}]`);
  expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
});

// Окно согласия и экраны паузы (задача 34) закрывают обычные экраны и
// показываются только без согласия — обход SCREENS под фикстурой их не видит.
// Плашка «Сейчас у вас включено» лежит на жёлтой подложке: серый текст на ней
// в тёмной теме давал 4.42 (посчитано на канве), поэтому там основной цвет.
test('окно согласия и пауза: контраст не ниже AA в обеих темах', async ({ page }) => {
  await openApp(page, '/', { consentAt: null });
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    await db.sync.put({
      id: 'config', accountId: 'acc', authToken: 'tok', key: await generateKey(), enabled: true,
      lastPullAt: '', lastPushAt: '', lastSyncedAt: '',
    } as never);
  });
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Что уходит с телефона' });
  await expect(dialog.getByText('Сейчас у вас включено')).toBeVisible();

  const bad: string[] = [];
  const both = async (where: string) => {
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate((t) => document.documentElement.classList.toggle('light', t === 'light'), theme);
      // Цвета меняются с переходом — мерить посреди него значит мерить смесь тем.
      await page.waitForTimeout(400);
      for (const f of await scan(page)) bad.push(`${where} (${theme}) — «${f.что}» ${f.контраст}:1 (нужно ${f.нужно})`);
    }
  };
  await both('окно, коротко');
  await dialog.getByRole('button', { name: 'Подробно, по каждой функции' }).click();
  await both('окно, подробно');
  await dialog.getByRole('button', { name: 'Коротко' }).click();
  await dialog.getByRole('button', { name: 'Не принимать — поставить на паузу' }).click();
  await expect(dialog).toBeHidden();
  await page.goto('/more/settings');
  await expect(page.getByText('Внешнее на паузе')).toBeVisible();
  await both('настройки на паузе');
  await page.goto('/more/family');
  await both('семья на паузе');

  expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
});

// Кнопки, перекрашенные через className, проигрывали классу варианта Button:
// классы склеиваются строкой, оба в одном слое, и побеждает тот, что ниже в
// собранном CSS. «Исключить» (primary) выходила белым по золоту — 2.29:1,
// «Очистить день» (ghost) — золотом вместо красного, что контраст не ловит:
// золото на шторке AA проходит. Поэтому, кроме замера, — сверка с токеном.
// Обе шторки открываются только действием, обход SCREENS их не видит.
test('шторки «Исключить» и «Очистить день»: красные и не ниже AA в обеих темах', async ({ page }) => {
  const sheet = page.locator('[class*="animate-sheet-up"]');
  /** Цвет элемента — ровно токен. Пробный элемент нужен, чтобы оба значения
   *  сериализовал один движок: в токене 'oklch(0.70 …)', в стиле 'oklch(0.7 …)'. */
  const isToken = (loc: Locator, prop: 'color' | 'backgroundColor', token: string) =>
    loc.evaluate((el, [p, tk]) => {
      const probe = document.createElement('i');
      probe.style[p] = `var(${tk})`;
      document.body.append(probe);
      const want = getComputedStyle(probe)[p];
      probe.remove();
      return getComputedStyle(el)[p] === want;
    }, [prop, token] as const);
  const bad: string[] = [];
  const both = async (where: string, check: () => Promise<void>) => {
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate((t) => document.documentElement.classList.toggle('light', t === 'light'), theme);
      await page.waitForTimeout(400);
      await check();
      for (const f of await scan(page, sheet)) bad.push(`${where} (${theme}) — «${f.что}» ${f.контраст}:1 (нужно ${f.нужно})`);
    }
  };

  await openApp(page, '/more/family');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    const ts = new Date().toISOString();
    // ownerSecret — иначе кнопки исключения нет вовсе (её видит только создатель).
    await db.family.put({
      id: 'f1', familyId: 'f1', familyToken: 't', familyKey: key, familyName: 'Наши',
      selfMemberId: 'me', lastSeq: 0, lastReadSeq: 0, enabled: true, joinedAt: ts,
      keyEpoch: 0, keyRing: { '0': key }, ownerSecret: 's',
    } as never);
    await db.familyMembers.bulkPut([
      { id: 'me', familyId: 'f1', seq: 1, displayName: 'Влад', color: '#5b7cfa', joinedAt: ts, leftAt: null, removedAt: null },
      { id: 'p1', familyId: 'f1', seq: 2, displayName: 'Отец', color: '#10b981', joinedAt: ts, leftAt: null, removedAt: null },
    ] as never[]);
  });
  await page.goto('/more/family?g=f1');
  await openFamilyChrome(page);
  await page.getByRole('button', { name: 'Участники' }).click();
  await page.getByRole('button', { name: 'Исключить Отец' }).click();
  const remove = sheet.getByRole('button', { name: 'Исключить', exact: true });
  await expect(remove).toBeEnabled();
  await both('исключение', async () => {
    expect.soft(await isToken(remove, 'backgroundColor', '--app-danger-fill'), 'фон «Исключить» не красный').toBe(true);
  });
  await sheet.getByRole('button', { name: 'Отмена' }).click();
  await expect(sheet).toHaveCount(0);

  await page.goto('/more/cycle');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const repo = await import('/src/lib/cycle/cycleRepo.ts');
    const { todayKey } = await import('/src/lib/dates.ts');
    const ts = new Date().toISOString();
    await repo.ensureCycleSetup();
    // Только заметка, без кровотечения: выбранный чип уровня — красный текст
    // на своей подложке /15, а в светлой теме это 4.27 у всего приложения
    // ([планка] PROTOCOL §1.2, чинится токеном --app-danger, не здесь).
    await db.cycleDays.put({
      date: todayKey(), note: 'Голова', symptomKeys: [],
      createdAt: ts, updatedAt: ts, source: 'user',
    } as never);
    await repo.rebuildCycles();
  });
  await page.getByRole('button', { name: 'Отметить', exact: true }).click();
  const clear = sheet.getByRole('button', { name: 'Очистить день' });
  await expect(clear).toBeVisible();
  await both('журнал дня', async () => {
    expect.soft(await isToken(clear, 'color', '--app-danger'), '«Очистить день» не красная').toBe(true);
  });

  expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
});

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
