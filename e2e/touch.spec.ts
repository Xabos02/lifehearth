import { test, expect, openApp } from './fixtures';
import type { Page } from '@playwright/test';

// Зона касания меньше 44×44 — самый частый дефект мобильной вёрстки и
// отдельный пункт в HIG. Считаем не по размеру самой кнопки: в приложении
// есть HIT_SLOP_44 — невидимый псевдоэлемент, который расширяет зону, не
// раздувая вид. Поэтому меряем ::after вместе с кнопкой.

const SCREENS = ['/', '/tasks', '/notes', '/calendar', '/goals', '/home',
  '/more/finance', '/more/habits', '/more/cycle', '/more/settings',
  // Аудит нашёл здесь кнопки 21×21 и 37×37 — экраны просто не были в списке.
  '/more/ai', '/more/focus', '/more/learning', '/more/energy', '/more/places',
  '/more/health',
  '/home/profile', '/share'];

async function small(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0' || cs.pointerEvents === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      let w = r.width;
      let h = r.height;
      // HIT_SLOP_44 живёт на ::after с отрицательными отступами — computed
      // размеры псевдоэлемента дают реальную зону.
      const a = getComputedStyle(el, '::after');
      if (a.content !== 'none' && a.position === 'absolute') {
        const pw = parseFloat(a.width);
        const ph = parseFloat(a.height);
        if (Number.isFinite(pw) && pw > w) w = pw;
        if (Number.isFinite(ph) && ph > h) h = ph;
      }
      if (w < 44 || h < 44) {
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30);
        bad.push(`«${label}» ${Math.round(w)}×${Math.round(h)} [${(el.getAttribute('class') || '').slice(0, 50)}]`);
      }
    }
    return bad;
  });
}

/** Насыпать экранам содержимого.
 *
 *  Аудит ходил по адресам с ПУСТОЙ базой — и не видел ни строки задачи, ни
 *  заголовка проекта, ни карандаша подпроекта: на пустом экране их просто нет.
 *  Сторож смотрел на пустые состояния и был доволен. Поэтому мелкие кнопки в
 *  самом нагруженном разделе приложения дожили до ручного разбора. */
async function seedForAudit(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    const base = (id: string) => ({ id, createdAt: now, updatedAt: now, deletedAt: null });
    const task = (id: string, title: string, projectId: string | null, extra = {}) => ({
      ...base(id), title, notes: '', projectId, goalId: null, priority: 0,
      dueDate: null, dueTime: null, duration: null, remindBefore: null,
      completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: 1000, ...extra,
    });
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    await db.projects.bulkPut([
      { ...base('a1'), name: 'Бизнес', color: '#5b7cfa', emoji: '💼', sortOrder: 1000, archivedAt: null, parentId: null },
      { ...base('a2'), name: 'Поставщики', color: '#f59e0b', emoji: '📦', sortOrder: 1000, archivedAt: null, parentId: 'a1' },
    ] as never[]);
    await db.tasks.bulkPut([
      task('at1', 'Позвонить поставщику', 'a1'),
      // Просроченная: у неё появляется кнопка «пропустить», которой нет у обычной.
      task('at2', 'Отправить документы', 'a1', { dueDate: yesterday }),
      task('at3', 'Сверить остатки', 'a2'),
      task('at4', 'Задача без проекта', null),
      task('at5', 'Уже сделано', 'a1', { completedAt: now }),
    ] as never[]);
    await db.goals.bulkPut([
      { ...base('ag1'), title: 'Закончить обучение', description: '', targetDate: null, status: 'active', metric: null, sortOrder: 0 },
    ] as never[]);
    await db.notes.bulkPut([
      { ...base('an1'), title: 'Заметка', content: '<div>Заметка</div>', tags: [], pinned: false, folderId: null },
    ] as never[]);
  });
}

test('зона касания не меньше 44×44', async ({ page }) => {
  await openApp(page);
  await seedForAudit(page);
  const bad = new Set<string>();
  for (const path of SCREENS) {
    await page.evaluate((p) => {
      history.pushState({}, '', p);
      dispatchEvent(new PopStateEvent('popstate'));
    }, path);
    await page.waitForTimeout(400);
    for (const b of await small(page)) bad.add(`${path}: ${b}`);
  }
  expect([...bad], `мелких зон: ${bad.size}`).toEqual([]);
});

test('расширение зоны касания не сдвигает кнопки', async ({ page }) => {
  // HIT_SLOP_44 несёт relative — а Tailwind решает конфликт двух position не
  // по порядку в атрибуте class, а по порядку правил в CSS. На элементе,
  // который уже absolute, relative побеждал, и кнопка уезжала из своего угла
  // в поток. Так крестик на карточке «Защитите свои данные» переехал от
  // правого верхнего угла к заголовку — тест на 44×44 этого не видел, зона-то
  // стала правильной.
  await openApp(page);
  const bad = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('button, a[href]')) {
      const cs = getComputedStyle(el);
      const after = getComputedStyle(el, '::after');
      const hasSlop = after.content !== 'none' && after.position === 'absolute'
        && parseFloat(after.width) >= 40;
      if (!hasSlop) continue;
      // У элемента с расширенной зоной position обязан остаться тем, что
      // задумал автор: relative допустим, static — нет (значит его сбросили),
      // absolute/fixed — значит автор позиционировал сам и relative не пришёл.
      if (cs.position === 'static') {
        out.push(`${el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 20)}: position static`);
      }
      // Кнопка с классом absolute обязана остаться absolute.
      // Утилиту ищем как отдельный класс, а не подстрокой: сам хит-слоп несёт
      // after:absolute, и наивный поиск по слову объявлял нарушением каждую
      // кнопку с расширенной зоной.
      const classes = (el.getAttribute('class') || '').split(/\s+/);
      const cls = classes.join(' ');
      void cls;
      if (classes.includes('absolute') && cs.position !== 'absolute') {
        out.push(`${el.getAttribute('aria-label') || '?'}: класс absolute, а position ${cs.position}`);
      }
      if (classes.includes('fixed') && cs.position !== 'fixed') {
        out.push(`${el.getAttribute('aria-label') || '?'}: класс fixed, а position ${cs.position}`);
      }
    }
    return out;
  });
  expect(bad).toEqual([]);
});

// Зоны касания соседних кнопок не должны налезать друг на друга.
//
// 44×44 — только половина требования. Кнопка шириной 36px с расширенной до 44
// зоной выходит на 4px за свои края в каждую сторону; поставь такие в ряд с
// зазором 4px — и зоны сомкнутся. Палец, целящийся в одну, попадает в соседнюю,
// причём внешне всё выглядит просторно: перекрываются невидимые части.
//
// Так лупа «Искать в переписке» отбирала нажатия у кнопки звонка. Звонок —
// не та кнопка, которую прощают за случайное нажатие: он поднимает трезвон у
// человека на том конце.
test('семейный чат: зоны касания не меньше 44 и не налезают друг на друга', async ({ page }) => {
  await openApp(page, '/more/family');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const { generateKey } = await import('/src/lib/crypto.ts');
    const key = await generateKey();
    const ts = new Date().toISOString();
    await db.family.put({
      id: 'f1', familyId: 'f1', familyToken: 't', familyKey: key, familyName: 'Наши',
      selfMemberId: 'me', lastSeq: 1, lastReadSeq: 1, enabled: true, joinedAt: ts,
      keyEpoch: 0, keyRing: { '0': key },
    } as never);
    await db.familyMembers.bulkPut([
      { id: 'me', familyId: 'f1', seq: 1, displayName: 'Влад', color: '#5b7cfa', joinedAt: ts, leftAt: null, removedAt: null },
      { id: 'p1', familyId: 'f1', seq: 2, displayName: 'Отец', color: '#10b981', joinedAt: ts, leftAt: null, removedAt: null },
    ] as never[]);
  });
  await page.goto('/more/family?g=f1');
  await expect(page.getByRole('button', { name: 'Искать в переписке' })).toBeVisible();

  const overlaps = await overlapsOn(page);
  expect(overlaps).toEqual([]);

  // Экран семьи не входит в список аудита 44×44 выше — тот ходит по адресам
  // без семьи, а без неё шапка чата не рисуется вовсе.
  expect(await small(page), 'мелкие зоны в семейном чате').toEqual([]);
});

/** Пары кнопок, чьи зоны касания налезают друг на друга, на текущем экране. */
async function overlapsOn(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    /** Реальная зона касания: сама кнопка плюс расширяющий ::after. */
    const hitRect = (el: Element) => {
      const r = el.getBoundingClientRect();
      const a = getComputedStyle(el, '::after');
      let w = r.width;
      let h = r.height;
      if (a.content !== 'none' && a.position === 'absolute') {
        const pw = parseFloat(a.width);
        const ph = parseFloat(a.height);
        if (Number.isFinite(pw) && pw > w) w = pw;
        if (Number.isFinite(ph) && ph > h) h = ph;
      }
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
    };
    const root = document.querySelector('#root')!;
    const btns = [...root.querySelectorAll('button, a[href]')].filter((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.visibility !== 'hidden' && cs.pointerEvents !== 'none' && r.width > 0 && r.height > 0;
    });
    const bad: string[] = [];
    for (let i = 0; i < btns.length; i++) {
      for (let j = i + 1; j < btns.length; j++) {
        const a = btns[i];
        const b = btns[j];
        // Плавающие элементы лежат ПОВЕРХ списка по замыслу: кнопка «+» и
        // таб-бар прибиты к экрану, а не стоят в потоке. Их перекрытие с
        // содержимым — вопрос компоновки («лента должна кончаться выше
        // кнопки»), а не промаха пальцем, и меряется оно не здесь.
        const floating = (el: Element) => {
          const pos = getComputedStyle(el).position;
          return pos === 'fixed' || pos === 'sticky';
        };
        if (floating(btns[i]) || floating(btns[j])) continue;
        // И только соседей ВНУТРИ одной прокручиваемой области. Зона нижней
        // видимой строки списка вылезает за его край и формально накрывает
        // таб-бар — но там она обрезана и пальцу недоступна: это артефакт
        // замера, а не промах.
        const scrollerOf = (el: Element | null): Element | null => {
          let cur = el?.parentElement ?? null;
          while (cur) {
            const oy = getComputedStyle(cur).overflowY;
            if (oy === 'auto' || oy === 'scroll') return cur;
            cur = cur.parentElement;
          }
          return null;
        };
        if (scrollerOf(btns[i]) !== scrollerOf(btns[j])) continue;
        // Вложенные друг в друга — законный случай (кнопка внутри кликабельной
        // карточки), меряем только соседей.
        if (a.contains(b) || b.contains(a)) continue;
        const ra = hitRect(a);
        const rb = hitRect(b);
        const dx = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const dy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (dx > 0 && dy > 0) {
          const name = (el: Element) =>
            (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24);
          bad.push(`«${name(a)}» и «${name(b)}» налезают на ${Math.round(dx)}×${Math.round(dy)}px`);
        }
      }
    }
    return bad;
  });

}

test('раздел «Задачи»: зоны касания не налезают друг на друга', async ({ page }) => {
  // Заголовкам, «Выполненным» и кнопкам добавления подняли высоту до нормы —
  // а рядом с заголовком стоит карандаш. Здесь и проверяется, что от лечения
  // одного не заболело другое: невидимые зоны не должны перекрываться.
  await openApp(page, '/tasks');
  await seedForAudit(page);
  await page.goto('/tasks');
  await expect(page.getByText('Позвонить поставщику')).toBeVisible();

  // Исключений больше нет. Было одно: у просроченной задачи «пропустить»
  // стояло СЛЕВА от чекбокса, в двенадцати пикселях, при зонах по 44 — и
  // считалось неизбежным, потому что развести их на левом краю телефона
  // негде. Кнопка уехала в конец строки, где соседей нет, и вопрос снялся
  // вместе с другой бедой того же расположения — сдвигом левого края списка.
  expect(await overlapsOn(page)).toEqual([]);
});

test('просроченная задача не ломает левый край списка', async ({ page }) => {
  // «Пропустить» стояло первым в строке и сдвигало вправо всё остальное на
  // 32px: у просроченной задачи чекбокс оказывался не на одной вертикали с
  // соседними, и ровный край списка ломался ровно там, где взгляд и так
  // тревожно останавливается.
  await openApp(page, '/tasks');
  await seedForAudit(page);
  await page.goto('/tasks');
  await expect(page.getByText('Отправить документы', { exact: true })).toBeVisible();

  // Сравниваем внутри ОДНОЙ секции: задача в подпроекте отступает вместе со
  // своей папкой, и это законно — сдвиг уровня, а не поломка края.
  const bySection = await page.evaluate(() => {
    const groups: Record<string, { title: string; left: number }[]> = {};
    for (const row of document.querySelectorAll('[data-task-id]')) {
      const section = row.closest('[data-drop-key]');
      const key = section?.getAttribute('data-drop-key') ?? 'нет секции';
      const el = row.querySelector('button');
      if (!el) continue;
      (groups[key] ??= []).push({
        title: row.querySelector('p')?.textContent?.trim() ?? '',
        left: Math.round(el.getBoundingClientRect().left),
      });
    }
    return groups;
  });

  const broken = Object.entries(bySection)
    .filter(([, rows]) => new Set(rows.map((r) => r.left)).size > 1)
    .map(([key, rows]) => `${key}: ${JSON.stringify(rows)}`);
  expect(broken, 'внутри секции чекбоксы стоят на разной вертикали').toEqual([]);
  // Страховка от пустого замера: секция с просроченной задачей обязана быть.
  expect(Object.values(bySection).flat().length).toBeGreaterThan(2);
});
