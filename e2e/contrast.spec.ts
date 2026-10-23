import { test, expect, openApp, openFamilyCard, seedFamilyChats } from './fixtures';
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
// поэтому ответ засеваем. И второй, упавший: «Повторить» — красный на
// подложке, лежащей на красной же карточке ошибки.
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
    await db.llmMessages.put({
      ...base('ai-e'), chatId: 'ai-c', role: 'assistant', content: '', model: 'm',
      tokensIn: 0, tokensOut: 0, costRub: 0, status: 'error', error: 'Нет связи',
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
    // Заливка — непрозрачный фон, который заметно отличается от каждой
    // поверхности темы: кнопка, пузырь, аватар, плашка. Глиф на ней — 4.5
    // при любом размере (CLAUDE.md, PROTOCOL §1.2); пол 3 для иконок — про
    // поверхности. Без этого белая стрелка на индиговой кнопке ИИ (3.33)
    // проходила как иконка. Подкрашенная поверхность — плитка .tile-lh,
    // подложка /15–/20 — отличается от своей на 1.23–1.45 и заливкой не
    // считается; настоящие заливки — от 3.
    const rootCs = getComputedStyle(document.documentElement);
    const surfaces = ['--app-bg', '--app-surface', '--app-surface-2', '--app-elevated',
      '--lh-bg', '--lh-surface', '--lh-surface-2'].map((v) => px(rootCs.getPropertyValue(v)));
    const distinct = (c: number[]) => surfaces.every((s) => ratio(c, s) >= 1.5);
    const bgOf = (el: Element): { bgs: number[][]; fill: boolean } => {
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
      const opaque = stack[stack.length - 1];
      const fill = grad.length > 0 ? grad.some(distinct) : opaque !== undefined && opaque[3] >= 0.999 && distinct(opaque);
      const bases = grad.length ? grad : [[14, 14, 21, 1]];
      return {
        fill,
        bgs: bases.map((base) => {
          let out = [base[0], base[1], base[2]];
          for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
          return out;
        }),
      };
    };

    const found: Finding[] = [];
    // Корень — тоже кандидат: у чипа на подложке текст лежит прямо в нём.
    for (const el of [rootEl, ...rootEl.querySelectorAll('*')]) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const ownText = [...el.childNodes]
        .filter((n) => n.nodeType === 3).map((n) => n.textContent!.trim()).join('');
      const isIcon = el.tagName === 'svg';
      if (!ownText && !isIcon) continue;
      const fg = px(isIcon ? (cs.stroke !== 'none' ? cs.stroke : cs.color) : cs.color);
      const { bgs, fill } = bgOf(el);
      const c = Math.min(...bgs.map((bg) => ratio(over(fg, bg), bg)));
      const size = parseFloat(cs.fontSize) || 17;
      const bold = Number(cs.fontWeight) >= 600;
      // Пороги WCAG AA: 3.0 для крупного текста и графики, 4.5 для обычного;
      // на заливке — 4.5 всему.
      const need = !fill && (isIcon || size >= 24 || (bold && size >= 19)) ? 3 : 4.5;
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

// Текущее состояние экрана — в обеих темах, без перехода по адресу.
async function scanThemes(page: Page, where: string): Promise<string[]> {
  const bad: string[] = [];
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => document.documentElement.classList.toggle('light', t === 'light'), theme);
    // Цвета меняются с переходом — мерить посреди него значит мерить смесь тем.
    await page.waitForTimeout(400);
    for (const f of await scan(page)) bad.push(`${where} (${theme}) — «${f.что}» ${f.контраст}:1 (нужно ${f.нужно})`);
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

// Пустой раздел семьи — экран подключения, и обход SCREENS не видел ни
// своего пузыря чата (золото, а метки, цитата и ссылки в нём оставались
// белыми от индигового: 1.82–2.29), ни инициалов на цвете участника (белое
// на #ffffff — 1.0), ни свёрнутого звонка (белое на зелёном — 1.75). Цвета
// участников — те, на которых белый глиф и проваливался: белый, лаймовый и
// голубой, где старый порог яркости тоже выбирал белый (2.65).
test('семья: свои сообщения, участники, звонок и форма задачи — контраст в обеих темах', async ({ page }) => {
  await page.route(/\/family\/ticket/, (r) => r.fulfill({ json: { ticket: 't' } }));
  await page.routeWebSocket(/\/family\/ws/, (ws) => {
    ws.onMessage((m) => {
      // Мама прочитала всё — у своих сообщений двойная галочка «прочитано».
      if (JSON.parse(String(m)).type === 'hello') {
        ws.send(JSON.stringify({ type: 'ready', online: ['me'], reads: [{ memberId: 'mom', seq: 99 }] }));
      }
    });
  });
  await openApp(page, '/more/family');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    const ts = new Date().toISOString();
    await db.family.put({
      id: 'f1', familyId: 'f1', familyToken: 't', familyKey: key, familyName: 'Наши',
      selfMemberId: 'me', lastSeq: 4, lastReadSeq: 4, enabled: true, joinedAt: ts,
      keyEpoch: 0, keyRing: { '0': key },
    } as never);
    const member = (id: string, displayName: string, color: string) =>
      ({ id, familyId: 'f1', seq: 1, displayName, color, joinedAt: ts, leftAt: null, removedAt: null });
    await db.familyMembers.bulkPut([
      member('me', 'Влад', '#ffffff'), member('mom', 'Мама', '#a3e635'), member('dad', 'Папа', '#7c9aff'),
    ] as never[]);
    const msg = (clientMsgId: string, seq: number | null, senderMemberId: string, text: string, extra = {}) =>
      ({ clientMsgId, familyId: 'f1', seq, senderMemberId, text, createdAt: ts, deletedAt: null, status: 'acked', ...extra });
    await db.familyMessages.bulkPut([
      msg('m1', 1, 'mom', 'Билеты на субботу взяла'),
      msg('m2', 2, 'me', 'Отлично, маршрут: https://example.com/route', {
        replyTo: { id: 'm1', name: 'Мама', text: 'Билеты на субботу взяла' }, editedAt: ts,
      }),
      msg('m3', 3, 'me', '', { audio: 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=', audioDur: 14 }),
      msg('m4', 4, 'me', '', {
        file: { fileId: 'fl', name: 'Билеты.pdf', mime: 'application/pdf', size: 120000, chunksTotal: 1 },
        fileData: 'data:application/pdf;base64,JVBERi0=',
      }),
      msg('m5', null, 'me', 'Во сколько выезжаем?', { status: 'pending' }),
    ] as never[]);
    await db.familyTasks.put({
      id: 't1', familyId: 'f1', seq: 5, title: 'Купить хлеб', notes: '', priority: 0, dueDate: null, dueTime: null,
      remindBefore: null, color: '#a3e635', assigneeId: 'mom', createdBy: 'me', completedAt: null,
      completedBy: null, deletedAt: null, sortOrder: 1000,
    } as never);
  });
  await page.goto('/more/family?g=f1');
  await expect(page.getByText('Во сколько выезжаем?')).toBeVisible();
  await expect(page.getByText('Билеты.pdf')).toBeVisible();
  // Связь поднялась — отметка «прочитано» дошла до своих сообщений.
  await expect(page.locator('.lucide-check-check').first()).toBeVisible();

  // Подпись автора на цвете участника (лаймовый «Мама») — та, что проваливала
  // контраст; без неё скан чата прошёл бы мимо.
  await expect(page.locator('p.member-color', { hasText: 'Мама' })).toBeVisible();
  const bad: string[] = [];
  bad.push(...(await scanThemes(page, 'чат')));

  // «Кому позвонить» — из шапки чата: в карточке группы трубка у каждого.
  await page.getByRole('button', { name: 'Позвонить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Кому позвонить' })).toBeVisible();
  bad.push(...(await scanThemes(page, 'кому позвонить')));
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByRole('heading', { name: 'Кому позвонить' })).toBeHidden();

  await openFamilyCard(page);
  await expect(page.getByText('Папа')).toBeVisible();
  bad.push(...(await scanThemes(page, 'участники')));

  await page.getByRole('button', { name: 'Задачи' }).click();
  await page.getByRole('button', { name: 'Изменить задачу', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Мама', exact: true })).toBeVisible();
  bad.push(...(await scanThemes(page, 'форма задачи')));
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByRole('button', { name: 'Мама', exact: true })).toBeHidden();

  // Звонок без сети не поднять — состояние «идёт разговор» ставится напрямую,
  // и оверлей сворачивается настоящей кнопкой.
  await page.evaluate(async () => {
    const { callManager } = await import('/src/lib/family/familyCall.ts');
    (callManager as unknown as { set(p: object): void })
      .set({ status: 'active', familyId: 'f1', peerId: 'mom', peerName: 'Мама', startedAt: Date.now() });
  });
  await page.getByRole('button', { name: 'Свернуть звонок' }).click();
  await expect(page.getByRole('button', { name: /Развернуть звонок/ })).toBeVisible();
  bad.push(...(await scanThemes(page, 'свёрнутый звонок')));

  expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
});

// Список чатов «Семьи» и карточки: аватары на цвете участника (в том числе
// белый — его кругу нужна граница), золотой бейдж и время непрочитанного,
// пунктир «Нового личного чата». Обход SCREENS видит семью пустой — экран
// подключения, — поэтому список засеивается здесь.
test('семья: список чатов, карточка личного чата и «Новый чат» — контраст в обеих темах', async ({ page }) => {
  await openApp(page, '/more/family');
  await seedFamilyChats(page);
  await page.goto('/more/family');
  await expect(page.getByRole('heading', { name: 'Личные' })).toBeVisible();
  // Золотой бейдж и время непрочитанного уже нарисованы — их и мерим.
  await expect(page.getByRole('button', { name: /Мама.*2 непрочитанных/ })).toBeVisible();
  const bad: string[] = [];
  bad.push(...(await scanThemes(page, 'список чатов')));

  await page.getByRole('button', { name: 'Новый личный чат' }).click();
  await expect(page.getByRole('heading', { name: 'Новый чат' })).toBeVisible();
  bad.push(...(await scanThemes(page, 'новый чат')));
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(page.getByRole('heading', { name: 'Новый чат' })).toBeHidden();

  await page.goto('/more/family?g=p-anya&t=members');
  await expect(page.getByRole('button', { name: 'Выйти из группы' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Аня', level: 1, exact: true })).toBeVisible();
  bad.push(...(await scanThemes(page, 'карточка личного чата')));
  expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
});

// Кнопка «Отправить» в ИИ активна только с текстом в поле, а плитка с искрой
// видна только в пустом чате — обход SCREENS видел кнопку погашенной и
// плитку не видел вовсе. Белая стрелка на индиго #8B7CF6 давала 3.33.
test('ИИ: кнопка «Отправить» и плитка пустого чата — глиф на заливке', async ({ page }) => {
  await openApp(page, '/more/ai');
  await page.getByPlaceholder('Сообщение…').fill('Что у меня по задачам?');
  await expect(page.getByRole('button', { name: 'Отправить' })).toBeEnabled();
  const bad: string[] = [];
  bad.push(...(await scanThemes(page, 'ИИ')));
  expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
});

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
  const both = async (where: string) => { bad.push(...(await scanThemes(page, where))); };
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

// Светлое золото подбиралось по одному фону, а лежит ещё на surface-2 и на своей
// подложке lh-accent-dim — там #8A6D1F давал 3.69–4.30, а обход SCREENS был
// зелёным: такие пары появляются только в состоянии. «Больше не показывать»
// — под крестиком подсказки, «Завтра» — под свайпом задачи, выбранный симптом
// и «сегодня» в календаре — после отметки дня, «Учитывается в сводке» — в шите
// расхода.
test('золото на своей подложке и на surface-2: контраст в обеих темах', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    await db.tasks.put({
      id: 'gt1', createdAt: now, updatedAt: now, deletedAt: null, title: 'Задача', notes: '',
      projectId: null, goalId: null, priority: 0, dueDate: null, dueTime: null, duration: null,
      remindBefore: null, completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: 1000,
    } as never);
  });
  await page.goto('/tasks');
  const bad: string[] = [];

  await page.getByRole('button', { name: 'Скрыть подсказку' }).first().click();
  await expect(page.getByRole('button', { name: 'Больше не показывать' })).toBeVisible();
  const row = (await page.getByText('Задача', { exact: true }).first().boundingBox())!;
  const y = row.y + row.height / 2;
  await page.mouse.move(row.x + 150, y);
  await page.mouse.down();
  await page.mouse.move(row.x + 20, y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Завтра', exact: true })).toBeVisible();
  bad.push(...(await scanThemes(page, 'задачи: подсказка и свайп')));

  await page.goto('/more/cycle');
  await page.getByRole('button', { name: 'Отметить', exact: true }).click();
  await page.getByRole('button', { name: 'Усталость' }).click();
  await expect(page.getByRole('button', { name: 'Усталость' })).toHaveAttribute('aria-pressed', 'true');
  bad.push(...(await scanThemes(page, 'отметка дня: выбранный симптом')));
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator('[aria-current="date"]')).toBeVisible();
  bad.push(...(await scanThemes(page, 'календарь цикла: сегодня')));

  await page.goto('/more/finance');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Учитывается в сводке' })).toBeVisible();
  bad.push(...(await scanThemes(page, 'шит расхода')));

  expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
});

// Серый --lh-text-secondary на золотой подложке не держит AA ни в одной теме:
// поверх bg / surface / surface-2 — 4.30 / 4.62 / 4.09 в светлой и 4.77 /
// 4.40 / 4.05 в тёмной (канва design/muted-on-gold). Такие пары живут только
// в состоянии: цитата во входящем ответе и своя реакция в семейном чате,
// открытый чат и выбранная модель в шторках ИИ, цель переноса в «Задачах».
// Меряется всё, что лежит на подложке, — а у цели переноса вся секция: её
// подсветка от правки потеряла заливку, и мерить по классу было бы нечего.
async function scanRoots(page: Page, where: string, roots: () => Promise<Locator[]>): Promise<string[]> {
  const bad: string[] = [];
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => document.documentElement.classList.toggle('light', t === 'light'), theme);
    await page.waitForTimeout(400);
    const found = await roots();
    expect(found.length, `${where}: подложки нет — мерить нечего`).toBeGreaterThan(0);
    for (const root of found) {
      for (const f of await scan(page, root)) bad.push(`${where} (${theme}) — «${f.что}» ${f.контраст}:1 (нужно ${f.нужно})`);
    }
  }
  return bad;
}
const tints = (within: Locator) => () => within.locator('.bg-lh-accent-dim').all();

test('чат: цитата и своя реакция на золотой подложке — AA в обеих темах', async ({ page }) => {
  await openApp(page, '/more/family');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    const ts = new Date().toISOString();
    await db.family.put({
      id: 'f1', familyId: 'f1', familyToken: 't', familyKey: key, familyName: 'Наши',
      selfMemberId: 'me', lastSeq: 6, lastReadSeq: 6, enabled: true, joinedAt: ts,
      keyEpoch: 0, keyRing: { '0': key },
    } as never);
    await db.familyMembers.bulkPut([
      { id: 'me', familyId: 'f1', seq: 1, displayName: 'Влад', color: '#5b7cfa', joinedAt: ts, leftAt: null, removedAt: null },
      { id: 'p1', familyId: 'f1', seq: 2, displayName: 'Мама', color: '#10b981', joinedAt: ts, leftAt: null, removedAt: null },
    ] as never[]);
    const msg = (id: string, seq: number, sender: string, text: string, over: Record<string, unknown> = {}) => ({
      clientMsgId: id, familyId: 'f1', seq, senderMemberId: sender, text, status: 'acked', deletedAt: null,
      createdAt: new Date(Date.now() - (10 - seq) * 60000).toISOString(), ...over,
    });
    // Ответ Мамы с цитатой и «👍» от обоих: число на чипе видно от двух.
    await db.familyMessages.bulkPut([
      msg('m1', 3, 'me', 'Купить к ужину хлеб?'),
      msg('m2', 4, 'p1', 'Да, и молоко', { replyTo: { id: 'm1', name: 'Влад', text: 'Купить к ужину хлеб?' } }),
      msg('r1', 5, 'me', '', { reaction: { targetId: 'm2', emoji: '👍' } }),
      msg('r2', 6, 'p1', '', { reaction: { targetId: 'm2', emoji: '👍' } }),
    ] as never[]);
  });
  await page.goto('/more/family?g=f1');
  await expect(page.getByText('Да, и молоко')).toBeVisible();
  const bad = await scanRoots(page, 'чат', tints(page.locator('body')));
  expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
});

test('ИИ: открытый чат и выбранная модель на золотой подложке — AA в обеих темах', async ({ page }) => {
  // Шторки рисуются вне обёртки раздела, поэтому подложка в них золотая.
  await openApp(page, '/');
  // Засев до захода в раздел: пустой раздел заводит свой чат, и открытым
  // оказался бы он, а не засеянный.
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { MODELS } = await import('/src/lib/ai/models.ts');
    const now = new Date().toISOString();
    await db.llmChats.put({
      id: 'ai-c', createdAt: now, updatedAt: now, deletedAt: null, title: 'План', model: MODELS.at(-1)!.id,
      systemPrompt: '', lastMessageAt: now, lastMessageText: 'Перенесите на четверг', dataTools: false,
    } as never);
  });
  const sheet = page.locator('[class*="animate-sheet-up"]');
  await page.goto('/more/ai');
  await page.getByRole('button', { name: 'Список чатов' }).click();
  await expect(sheet.getByText('Перенесите на четверг')).toBeVisible();
  const bad = await scanRoots(page, 'список чатов', tints(sheet));
  await sheet.getByRole('button', { name: 'Закрыть' }).click();
  await expect(sheet).toHaveCount(0);
  await page.getByRole('button', { name: 'Модель', exact: true }).click();
  await expect(sheet).toBeVisible();
  bad.push(...(await scanRoots(page, 'модель', tints(sheet))));
  expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
});

test('задачи: цель переноса — AA в обеих темах', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.bulkPut([
      { ...base('p1'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null, parentId: null },
      { ...base('s1'), name: 'Поставщики', color: '#f59e0b', emoji: '📦', sortOrder: 1000, archivedAt: null, parentId: 'p1' },
      { ...base('p2'), name: 'Здоровье', color: '#3aa35e', emoji: '🏃', sortOrder: 2000, archivedAt: null, parentId: null },
    ] as never[]);
    const task = (id: string, title: string, projectId: string, completedAt: string | null = null) => ({
      ...base(id), title, notes: '', projectId, goalId: null, priority: 0, dueDate: null, dueTime: null,
      duration: null, remindBefore: null, completedAt, checklist: [], recurrence: null, tags: [], sortOrder: 1000,
    });
    // Выполненная задача и подпроект — чтобы в цели были «Выполненные»,
    // «Подпроект» и серое имя подпроекта.
    await db.tasks.bulkPut([
      task('dt1', 'Позвонить поставщику', 'p1'), task('dt2', 'Сверить счёт', 'p1', now),
      task('dt3', 'Пробежка', 'p2'), task('dt4', 'Заказать образцы', 's1'),
    ] as never[]);
  });
  await page.goto('/tasks');
  await page.getByText('Пробежка', { exact: true }).first().hover();
  await page.mouse.down();
  await expect(page.locator('.fixed.z-\\[70\\]'), 'перенос не стартовал').toBeVisible({ timeout: 2000 });
  const target = page.locator('[data-drop-key="p1"]');
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 20, { steps: 4 });
  await expect(target).toHaveClass(/(^|\s)ring-lh-accent(\s|$)/);
  const bad = await scanRoots(page, 'цель переноса', async () => [target]);
  await page.mouse.up();
  expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
});

test('задачи: спящая задача ручного повтора и ↻ на золотой подложке — AA в обеих темах', async ({ page }) => {
  await openApp(page, '/tasks');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    await db.projects.put({ ...base('p1'), name: 'Дом', color: '#5b7cfa', emoji: '📁', sortOrder: 1000, archivedAt: null, parentId: null } as never);
    await db.tasks.put({
      ...base('mr1'), title: 'Генеральная уборка', notes: '', projectId: 'p1', goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null, completedAt: now, checklist: [],
      recurrence: { type: 'manual' }, tags: [], sortOrder: 1000,
    } as never);
  });
  await page.goto('/tasks');
  const sec = page.locator('section[data-drop-key="p1"]');
  await expect(sec.getByRole('button', { name: 'Запустить снова' })).toBeVisible();
  const bad = await scanRoots(page, 'спящая задача', async () => [sec]);
  expect(bad, `пар ниже порога: ${bad.length}`).toEqual([]);
});

// Кнопки, перекрашенные через className, проигрывали классу варианта Button:
// классы склеиваются строкой, оба в одном слое, и побеждает тот, что ниже в
// собранном CSS. «Исключить» (primary) выходила белым по золоту — 2.29:1,
// «Очистить день» (ghost) — золотом вместо красного, что контраст не ловит:
// золото на шторке AA проходит. Поэтому, кроме замера, — сверка с токеном.
// Обе шторки открываются только действием, обход SCREENS их не видит.
// Заодно — красный на своей подложке: выбранный уровень, день кровотечения
// в календаре, «Удалить группу». Светлый --app-danger подбирался без неё, и
// все три шли на 4.27–4.29.
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
  const both = async (where: string, check: () => Promise<void>, root = sheet) => {
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate((t) => document.documentElement.classList.toggle('light', t === 'light'), theme);
      await page.waitForTimeout(400);
      await check();
      for (const f of await scan(page, root)) bad.push(`${where} (${theme}) — «${f.что}» ${f.контраст}:1 (нужно ${f.нужно})`);
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
  await openFamilyCard(page);
  // «Удалить группу» — красный текст строкой в карточке группы.
  const dropGroup = page.getByRole('button', { name: 'Удалить группу' });
  await both('участники: «Удалить группу»', async () => {}, dropGroup);
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
    // С кровотечением: выбранный чип уровня — красный текст на своей подложке
    // /15. Светлый --app-danger подбирался по трём поверхностям без неё, и чип
    // шёл на 4.27.
    await db.cycleDays.put({
      date: todayKey(), note: 'Голова', bleeding: 'medium', isBleedingDay: 1, symptomKeys: [],
      createdAt: ts, updatedAt: ts, source: 'user',
    } as never);
    await repo.rebuildCycles();
  });
  await page.getByRole('button', { name: 'Отметить', exact: true }).click();
  const clear = sheet.getByRole('button', { name: 'Очистить день' });
  await expect(clear).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Умеренно/ })).toHaveAttribute('aria-pressed', 'true');
  await both('журнал дня', async () => {
    expect.soft(await isToken(clear, 'color', '--app-danger'), '«Очистить день» не красная').toBe(true);
  });
  await sheet.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  bad.push(...(await scanThemes(page, 'календарь цикла: день кровотечения')));

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
