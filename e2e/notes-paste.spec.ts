import { test, expect, openApp } from './fixtures';
import type { Page } from '@playwright/test';

// Вставка в заметку — единственный путь, которым в неё попадает чужая разметка,
// и самый ходовой способ что-то в неё положить: человек копирует из таблицы,
// письма, статьи, мессенджера.
//
// Как это ломалось: заметка понимает узкий набор тегов, а DOMPurify, выбрасывая
// неразрешённый тег, ОСТАВЛЯЕТ его текст. Для таблицы это значило склейку:
// колонка из 22 товаров, скопированная из WPS Office, приезжала одной строкой
// «Джаммеры 800-900Джаммеры 900-1000…», а шапка таблицы пропадала совсем
// (<thead> у DOMPurify в FORBID_CONTENTS — удаляется вместе с содержимым).
//
// Поэтому здесь проверяется не «санитайз отработал», а «вставилось то же, что
// скопировали»: строка таблицы — строка заметки, абзац — абзац, заголовок —
// заголовок, и ничего из этого не исполняется как код.

/** Вставка через синтетическое событие: настоящий буфер в headless недоступен,
 *  а приложение слушает именно paste. */
async function paste(page: Page, text: string, html?: string) {
  await page.evaluate(
    ({ text, html }) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      if (html) dt.setData('text/html', html);
      document
        .querySelector('.note-editor')!
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { text, html },
  );
  await page.waitForTimeout(200);
}

async function newNote(page: Page) {
  await openApp(page, '/notes/new');
  await page.locator('.note-editor').click();
}

/** Текст заметки построчно — именно так его видит человек. */
async function lines(page: Page): Promise<string[]> {
  const text = await page.locator('.note-editor').innerText();
  // Неразрывные пробелы (зазор между колонками, отступ) схлопываем: здесь
  // проверяется разбивка на строки и текст, а не ширина зазора.
  return text
    .split('\n')
    .map((l) => l.replace(/[\u00A0\s]+/g, ' ').trim())
    .filter((l) => l !== '');
}

// ───────────────────────── таблицы ─────────────────────────

// Главный случай, с которого всё началось: колонка товаров из листа Excel.
// Разметка — настоящая, как её кладёт в буфер WPS Office / Excel на macOS.
const WPS_HTML = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><style><!--.xl65 {font-family:"Times New Roman";mso-number-format:General;}--></style></head><body link=blue vlink=purple><table border=0 cellpadding=0 cellspacing=0 width=640 style='border-collapse:collapse;table-layout:fixed'><col width=480><thead><tr><td class=xl65>Наименование</td><td class=xl65>Ед.</td><td class=xl65>Кол-во</td></tr></thead><tbody><tr height=20 style='height:15.0pt'><td height=20 class=xl65>Джаммеры 100Вт 800-900</td><td class=xl65>шт</td><td class=xl65 align=right>5</td></tr><tr height=20><td class=xl65>Джаммеры 100Вт 900-1000</td><td class=xl65>шт</td><td class=xl65 align=right>5</td></tr><tr height=20><td class=xl65>Джаммеры 100Вт 1000-1100</td><td class=xl65>шт</td><td class=xl65 align=right>5</td></tr><tr height=20><td class=xl65>&nbsp;</td><td class=xl65>&nbsp;</td><td class=xl65>&nbsp;</td></tr></tbody></table></body></html>`;
const WPS_TEXT = 'Наименование\tЕд.\tКол-во\r\nДжаммеры 100Вт 800-900\tшт\t5\r\nДжаммеры 100Вт 900-1000\tшт\t5\r\nДжаммеры 100Вт 1000-1100\tшт\t5\r\n\t\t';

test.describe('таблица из редактора таблиц', () => {
  test('строка таблицы — строка заметки, а не одна слипшаяся простыня', async ({ page }) => {
    await newNote(page);
    await paste(page, WPS_TEXT, WPS_HTML);
    const got = await lines(page);
    expect(got).toEqual([
      'Наименование Ед. Кол-во',
      'Джаммеры 100Вт 800-900 шт 5',
      'Джаммеры 100Вт 900-1000 шт 5',
      'Джаммеры 100Вт 1000-1100 шт 5',
    ]);
  });

  test('шапка таблицы не пропадает', async ({ page }) => {
    // <thead> у DOMPurify в FORBID_CONTENTS: без разбора строка заголовков
    // удалялась ВМЕСТЕ С ТЕКСТОМ — молча, и заметить это можно было только
    // сверив с источником.
    await newNote(page);
    await paste(page, WPS_TEXT, WPS_HTML);
    await expect(page.locator('.note-editor')).toContainText('Наименование');
  });

  test('колонки видно: между ячейками остаётся зазор', async ({ page }) => {
    // Обычный пробел и табуляция в HTML схлопываются — «шт» прилипало бы к
    // названию. Зазор держат неразрывные пробелы.
    await newNote(page);
    await paste(page, WPS_TEXT, WPS_HTML);
    const html = await page.locator('.note-editor').innerHTML();
    expect(html).toContain('&nbsp;');
    expect(html).not.toContain('800-900шт');
  });

  test('пустой хвост выделения не плодит пустые строки', async ({ page }) => {
    // В таблице выделяют мышкой, и выделение почти всегда захватывает пустые
    // строки снизу. Их в заметке быть не должно.
    await newNote(page);
    await paste(page, WPS_TEXT, WPS_HTML);
    expect(await lines(page)).toHaveLength(4);
  });

  test('таблица без tbody (разметка из Google Sheets)', async ({ page }) => {
    await newNote(page);
    await paste(
      page,
      'Ручка\t10\nБумага\t20',
      `<google-sheets-html-origin><table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0"><colgroup><col width="100"/></colgroup><tr><td style="border:1px solid #ccc">Ручка</td><td>10</td></tr><tr><td>Бумага</td><td>20</td></tr></table></google-sheets-html-origin>`,
    );
    expect(await lines(page)).toEqual(['Ручка 10', 'Бумага 20']);
  });

  test('вставленная таблица переживает сохранение и перезагрузку', async ({ page }) => {
    await newNote(page);
    await paste(page, WPS_TEXT, WPS_HTML);
    await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}/, { timeout: 5000 });
    await page.waitForTimeout(900);
    await page.reload();
    await page.waitForTimeout(600);
    expect(await lines(page)).toEqual([
      'Наименование Ед. Кол-во',
      'Джаммеры 100Вт 800-900 шт 5',
      'Джаммеры 100Вт 900-1000 шт 5',
      'Джаммеры 100Вт 1000-1100 шт 5',
    ]);
  });
});

// ───────────────────────── документы и веб ─────────────────────────

test.describe('документ и веб-страница', () => {
  test('Google Docs: вставка не становится жирной целиком', async ({ page }) => {
    // Google Docs кладёт весь фрагмент внутрь <b style="font-weight:normal">.
    // Санитайз срезает style — и оставался голый <b> на весь документ.
    await newNote(page);
    await paste(
      page,
      'Заголовок\nОбычный абзац',
      `<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-1a2b"><p dir="ltr"><span style="font-size:11pt">Заголовок</span></p><p dir="ltr"><span style="font-size:11pt">Обычный абзац</span></p></b>`,
    );
    const html = await page.locator('.note-editor').innerHTML();
    expect(html, `вся вставка стала жирной: ${html}`).not.toContain('<b>');
    expect(await lines(page)).toEqual(['Заголовок', 'Обычный абзац']);
  });

  test('Word: служебная разметка mso не попадает в текст', async ({ page }) => {
    await newNote(page);
    await paste(
      page,
      'Договор\nПункт первый',
      `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><style><!-- p.MsoNormal {margin:0cm;font-size:11.0pt;} --></style></head><body lang=RU><!--StartFragment--><p class=MsoNormal><span lang=RU>Договор<o:p></o:p></span></p><p class=MsoNormal><span lang=RU>Пункт первый<o:p></o:p></span></p><!--EndFragment--></body></html>`,
    );
    const got = await lines(page);
    expect(got).toEqual(['Договор', 'Пункт первый']);
    await expect(page.locator('.note-editor')).not.toContainText('MsoNormal');
    await expect(page.locator('.note-editor')).not.toContainText('margin:0cm');
  });

  test('статья из браузера: заголовки остаются заголовками', async ({ page }) => {
    // h3–h6 санитайз выбрасывал вместе с переносом строки: подзаголовок
    // прилипал к предыдущему абзацу. h1 в заметке нарисован обычным текстом.
    await newNote(page);
    await paste(
      page,
      'Статья',
      `<h1>Как выбрать антенну</h1><p>Вводный абзац.</p><h3>Диапазон</h3><p>Про диапазон.</p><h3>Разъём</h3><p>Про разъём.</p>`,
    );
    await expect(page.locator('.note-editor h2')).toHaveCount(3);
    expect(await lines(page)).toEqual([
      'Как выбрать антенну',
      'Вводный абзац.',
      'Диапазон',
      'Про диапазон.',
      'Разъём',
      'Про разъём.',
    ]);
  });

  test('код из редактора: строки и отступы на месте', async ({ page }) => {
    // Внутри <pre> перевод строки значим, а в обычном HTML он схлопывается в
    // пробел — код приезжал одной строкой.
    await newNote(page);
    await paste(
      page,
      'код',
      `<pre>function f() {\n  return 1;\n}</pre>`,
    );
    const got = await lines(page);
    expect(got).toEqual(['function f() {', 'return 1;', '}']);
    // Отступ держится неразрывными пробелами: обычные схлопнулись бы.
    expect(await page.locator('.note-editor').innerHTML()).toContain('&nbsp;');
  });

  test('цитата из письма остаётся цитатой', async ({ page }) => {
    await newNote(page);
    await paste(page, 'цитата', `<p>Ответ:</p><blockquote><p>Первая строка</p><p>Вторая строка</p></blockquote>`);
    await expect(page.locator('.note-editor blockquote')).toHaveCount(1);
    await expect(page.locator('.note-editor blockquote')).toContainText('Первая строка');
    await expect(page.locator('.note-editor blockquote')).toContainText('Вторая строка');
  });

  test('списки и чек-листы из буфера сохраняют структуру', async ({ page }) => {
    await newNote(page);
    await paste(
      page,
      'список',
      `<p>Покупки</p><ul class="cl"><li data-done="1">Молоко</li><li>Хлеб</li></ul><ol><li>Первый</li><li>Второй</li></ol>`,
    );
    await expect(page.locator('.note-editor ul.cl > li')).toHaveCount(2);
    await expect(page.locator('.note-editor ul.cl > li[data-done="1"]')).toHaveCount(1);
    await expect(page.locator('.note-editor ol > li')).toHaveCount(2);
  });
});

// ───────────────────────── простой текст ─────────────────────────

test.describe('простой текст', () => {
  test('переносы Windows (\\r\\n) дают строки, а не слипшийся текст', async ({ page }) => {
    await newNote(page);
    await paste(page, 'Первая\r\nВторая\r\nТретья');
    expect(await lines(page)).toEqual(['Первая', 'Вторая', 'Третья']);
  });

  test('переносы старого Mac (\\r) тоже', async ({ page }) => {
    await newNote(page);
    await paste(page, 'Первая\rВторая');
    expect(await lines(page)).toEqual(['Первая', 'Вторая']);
  });

  test('колонки из таблицы, когда в буфере только текст', async ({ page }) => {
    // Часть приложений кладёт в буфер лишь text/plain с табами между колонками.
    // Таб в HTML — обычный пробел, колонки слипались.
    await newNote(page);
    await paste(page, 'Товар\tЦена\nАнтенна\t1200');
    const html = await page.locator('.note-editor').innerHTML();
    expect(html).toContain('&nbsp;');
    expect(await lines(page)).toEqual(['Товар Цена', 'Антенна 1200']);
  });

  test('отступы не схлопываются', async ({ page }) => {
    await newNote(page);
    await paste(page, 'Список:\n    первый уровень\n        второй уровень');
    const raw = await page.locator('.note-editor').textContent();
    expect(raw).toContain('\u00A0\u00A0\u00A0 первый');
  });

  test('пустая строка между абзацами остаётся', async ({ page }) => {
    await newNote(page);
    await paste(page, 'Абзац один\n\nАбзац два');
    // Пустая строка — своя строка редактора, а не пропавший перенос.
    expect(await page.locator('.note-editor').innerHTML()).toContain('<div><br></div>');
    expect(await lines(page)).toEqual(['Абзац один', 'Абзац два']);
  });

  test('символы разметки показываются как символы', async ({ page }) => {
    await newNote(page);
    await paste(page, 'Заголовок\nусловие a<b и b>c\nкоманда <script>нет</script>\nсущность &#8594; и &amp;');
    const text = await page.locator('.note-editor').innerText();
    expect(text).toContain('a<b и b>c');
    expect(text).toContain('<script>нет</script>');
    expect(text).toContain('&#8594;');
    expect(text).toContain('&amp;');
  });
});

// ───────────────────────── место вставки ─────────────────────────

test.describe('куда вставляется', () => {
  test('вставка в середину строки не разрывает строку', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Заголовок');
    await page.keyboard.press('Enter');
    await page.keyboard.type('цена  рублей'); // два пробела: между ними встанет вставка
    for (let i = 0; i < ' рублей'.length; i++) await page.keyboard.press('ArrowLeft');
    await paste(page, '1200');
    // Первая буква строки поднята автозаглавной — это своё, отдельное поведение.
    expect(await lines(page)).toEqual(['Заголовок', 'Цена 1200 рублей']);
  });

  test('вставка поверх выделения заменяет выделенное', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Заголовок');
    await page.keyboard.press('Enter');
    await page.keyboard.type('старое значение');
    for (let i = 0; i < 'значение'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
    await paste(page, 'новое');
    expect(await lines(page)).toEqual(['Заголовок', 'Старое новое']);
  });

  test('вставка в пустую заметку: первая строка — заголовок', async ({ page }) => {
    await newNote(page);
    await paste(page, WPS_TEXT, WPS_HTML);
    const size = await page.evaluate(() => {
      const el = document.querySelector('.note-editor')!;
      const n = el.firstChild;
      const probe = n && n.nodeType === Node.ELEMENT_NODE ? (n as Element) : el;
      return parseFloat(getComputedStyle(probe).fontSize);
    });
    expect(size).toBeGreaterThan(20);
  });

  test('тело вставки остаётся обычного кегля', async ({ page }) => {
    await newNote(page);
    await paste(page, WPS_TEXT, WPS_HTML);
    const size = await page.evaluate(() => {
      const d = document.querySelector('.note-editor div');
      return d ? parseFloat(getComputedStyle(d).fontSize) : null;
    });
    expect(size).toBeLessThan(20);
  });

  test('вставка в пункт списка не рвёт список', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Покупки');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Список задач' }).click();
    await page.keyboard.type('Молоко');
    await paste(page, ' 2 литра');
    await expect(page.locator('.note-editor ul.cl > li')).toHaveCount(1);
    await expect(page.locator('.note-editor ul.cl > li').first()).toContainText('Молоко 2 литра');
  });
});

// ───────────────────────── безопасность ─────────────────────────

test.describe('вставка не исполняет чужой код', () => {
  test('скрипт, обработчик и внешняя картинка из буфера', async ({ page }) => {
    const fired: string[] = [];
    await page.exposeFunction('__xss', (what: string) => void fired.push(what));
    await newNote(page);
    await paste(
      page,
      'Заголовок',
      `<p>Заголовок</p><script>window.__xss('script')</script><img src="x" onerror="window.__xss('onerror')"><a href="javascript:window.__xss('href')">ссылка</a><iframe src="javascript:window.__xss('iframe')"></iframe><svg><use href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/></svg>`,
    );
    await page.waitForTimeout(400);
    const html = await page.locator('.note-editor').innerHTML();
    expect(fired, `сработал чужой код: ${fired.join(', ')}`).toEqual([]);
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    // Текст ссылки при этом сохраняется — режется разметка, а не содержимое.
    await expect(page.locator('.note-editor')).toContainText('ссылка');
  });

  test('чужие классы из веба не доезжают', async ({ page }) => {
    await newNote(page);
    await paste(page, 'текст', `<p class="hidden">вставленный текст</p><div class="fixed inset-0 z-50">поверх</div>`);
    const html = await page.locator('.note-editor').innerHTML();
    expect(html).not.toContain('hidden');
    expect(html).not.toContain('fixed');
    await expect(page.getByText('вставленный текст')).toBeVisible();
  });

  test('в буфере только внешняя картинка — вставляется простой текст', async ({ page }) => {
    // Картинка по чужому URL вырезается целиком; если бы на этом разбор
    // кончался, вставка не делала бы НИЧЕГО при непустом буфере.
    await newNote(page);
    await paste(page, 'подпись к картинке', `<img src="https://evil.example/pixel.png">`);
    await expect(page.locator('.note-editor')).toContainText('подпись к картинке');
    await expect(page.locator('.note-editor img')).toHaveCount(0);
  });
});

// ───────────────────────── быстрый захват ─────────────────────────

test.describe('экран «Захват»', () => {
  test('текст из буфера становится заметкой построчно', async ({ page }) => {
    // Главный путь на iPhone: системного «поделиться» в PWA нет, и всё, что
    // человек ловит на ходу, проходит через «Вставить из буфера» → «В заметки».
    // У этого экрана была своя копия разбора текста — она не знала ни про
    // переносы Windows, ни про табуляцию между колонками.
    await openApp(page, '/share');
    await page.getByPlaceholder('Что сохранить?').fill('Заявка\r\nАнтенна\t2 шт\r\nКабель\t10 м');
    await page.getByRole('button', { name: 'В заметки' }).click();
    await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}/, { timeout: 5000 });
    expect(await lines(page)).toEqual(['Заявка', 'Антенна 2 шт', 'Кабель 10 м']);
  });
});

test.describe('картинка в буфере', () => {
  test('скриншот из буфера вставляется картинкой', async ({ page }) => {
    // Скриншот приходит файлом, а не разметкой: вставка такого буфера раньше
    // не делала ровно ничего — ни картинки, ни сообщения.
    await newNote(page);
    await page.keyboard.type('Снимок экрана');
    await page.evaluate(() => {
      const b64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'снимок.png', { type: 'image/png' }));
      document
        .querySelector('.note-editor')!
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('.note-editor img')).toHaveAttribute('src', /^data:image\//, { timeout: 5000 });
  });

  test('лист таблицы вставляется строками, даже если в буфере есть и картинка', async ({ page }) => {
    // Excel кладёт в буфер и снимок выделенного куска. Начни разбор с
    // картинки — вместо строк в заметку легла бы фотография таблицы.
    await newNote(page);
    await page.evaluate(
      ({ text, html }) => {
        const bin = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        dt.setData('text/html', html);
        dt.items.add(new File([bytes], 'лист.png', { type: 'image/png' }));
        document
          .querySelector('.note-editor')!
          .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      },
      { text: WPS_TEXT, html: WPS_HTML },
    );
    await page.waitForTimeout(400);
    await expect(page.locator('.note-editor img')).toHaveCount(0);
    expect(await lines(page)).toHaveLength(4);
  });
});

// ───────────────────────── структура, которой нет у заметки ─────────────────────────

test.describe('чужая блочная разметка', () => {
  test('список определений не склеивается в одну строку', async ({ page }) => {
    // Тот же механизм, что у таблицы: тега нет в списке заметки, DOMPurify
    // выбрасывает ТЕГ и оставляет текст — две строки становятся одной.
    await newNote(page);
    await paste(
      page,
      'словарь',
      `<dl><dt>Джаммер</dt><dd>подавитель сигнала</dd><dt>Рупор</dt><dd>направленная антенна</dd></dl>`,
    );
    expect(await lines(page)).toEqual(['Джаммер', 'подавитель сигнала', 'Рупор', 'направленная антенна']);
  });

  test('секции статьи остаются отдельными строками', async ({ page }) => {
    await newNote(page);
    await paste(page, 'статья', `<section><p>Первый раздел</p></section><section><p>Второй раздел</p></section>`);
    expect(await lines(page)).toEqual(['Первый раздел', 'Второй раздел']);
  });

  test('вложенный список рядом с пунктом не пропадает', async ({ page }) => {
    // Word и Google Docs кладут вложенный список НЕ внутрь <li>, а рядом с
    // ним. Такой список выбрасывался целиком, со всеми подпунктами.
    await newNote(page);
    await paste(
      page,
      'список',
      `<ul><li>Антенны</li><ul><li>Рупорная</li><li>Спиральная</li></ul><li>Джаммеры</li></ul>`,
    );
    await expect(page.locator('.note-editor li')).toHaveCount(4);
    await expect(page.locator('.note-editor')).toContainText('Рупорная');
    await expect(page.locator('.note-editor')).toContainText('Спиральная');
  });

  test('письмо, свёрстанное таблицей, остаётся абзацами', async ({ page }) => {
    // Рассылки и деловые письма верстают таблицей-каркасом. Сминать такую
    // строку в одну строку заметки нельзя — внутри неё целые абзацы.
    await newNote(page);
    await paste(
      page,
      'письмо',
      `<table><tr><td><p>Здравствуйте!</p><p>Направляем счёт на оплату.</p><p>С уважением, отдел продаж</p></td></tr></table>`,
    );
    expect(await lines(page)).toEqual([
      'Здравствуйте!',
      'Направляем счёт на оплату.',
      'С уважением, отдел продаж',
    ]);
  });

  test('таблица внутри таблицы остаётся строками', async ({ page }) => {
    await newNote(page);
    await paste(
      page,
      'вложенная',
      `<table><tr><td><table><tr><td>Джаммеры 800-900</td><td>12 шт</td></tr><tr><td>Джаммеры 900-1000</td><td>7 шт</td></tr></table></td></tr></table>`,
    );
    expect(await lines(page)).toEqual(['Джаммеры 800-900 12 шт', 'Джаммеры 900-1000 7 шт']);
  });

  test('нумерация со сдвигом сохраняется', async ({ page }) => {
    await newNote(page);
    await paste(page, 'пункты', `<p>Продолжение</p><ol start="5"><li>Пятый</li><li>Шестой</li></ol>`);
    await expect(page.locator('.note-editor ol')).toHaveAttribute('start', '5');
  });
});

// ───────────────────────── выделение из документов ─────────────────────────

test.describe('выделение текста', () => {
  test('жирный, курсив и зачёркнутый из Google Docs доезжают', async ({ page }) => {
    // Docs и Word задают выделение не тегами, а style — санитайз его срезает,
    // и зачёркнутая (то есть отменённая) цена в КП читалась как действующая.
    await newNote(page);
    await paste(
      page,
      'цены',
      `<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-9"><p dir="ltr"><span style="font-weight:700">Итого</span><span>: </span><span style="text-decoration:line-through">1200 ₽</span><span> </span><span style="font-style:italic">по акции</span></p></b>`,
    );
    await expect(page.locator('.note-editor b')).toContainText('Итого');
    await expect(page.locator('.note-editor s')).toContainText('1200');
    await expect(page.locator('.note-editor i')).toContainText('по акции');
    // И при этом вся вставка не стала жирной целиком.
    await expect(page.locator('.note-editor b')).toHaveCount(1);
  });

  test('<del> и <ins> становятся зачёркнутым и подчёркнутым', async ({ page }) => {
    await newNote(page);
    await paste(page, 'правка', `<p>Цена <del>1200</del> <ins>990</ins> ₽</p>`);
    await expect(page.locator('.note-editor s')).toContainText('1200');
    await expect(page.locator('.note-editor u')).toContainText('990');
  });
});

// ───────────────────────── пустые строки ─────────────────────────

test.describe('пустые строки', () => {
  test('пустой абзац между абзацами сохраняется', async ({ page }) => {
    await newNote(page);
    await paste(page, 'текст', `<p>Первый абзац</p><p></p><p>Второй абзац</p>`);
    expect(await page.locator('.note-editor').innerHTML()).toContain('<div><br></div>');
  });

  test('хвост Apple-interchange-newline не даёт лишней строки', async ({ page }) => {
    // Chrome и Safari дописывают его в конец КАЖДОГО копирования со страницы.
    await newNote(page);
    await paste(page, 'текст', `<p>Единственная строка</p><br class="Apple-interchange-newline">`);
    expect(await page.locator('.note-editor').innerHTML()).not.toContain('<br>');
  });

  test('ведущая пустая строка из письма не съедает заголовок', async ({ page }) => {
    await newNote(page);
    await paste(page, 'письмо', `<p></p><p>Коммерческое предложение</p><p>Условия ниже</p>`);
    const size = await page.evaluate(() => {
      const el = document.querySelector('.note-editor')!;
      const n = el.firstChild;
      const probe = n && n.nodeType === Node.ELEMENT_NODE ? (n as Element) : el;
      return parseFloat(getComputedStyle(probe).fontSize);
    });
    expect(size).toBeGreaterThan(20);
    await expect(page.locator('.note-editor')).toContainText('Коммерческое предложение');
  });

  test('пустая строка внутри кода сохраняется', async ({ page }) => {
    await newNote(page);
    await paste(page, 'код', `<pre>const a = 1;\n\nconst b = 2;</pre>`);
    expect(await page.locator('.note-editor').innerHTML()).toContain('<div><br></div>');
  });

  test('хвостовой перенос простого текста не даёт пустой строки', async ({ page }) => {
    await newNote(page);
    await paste(page, 'Строка один\nСтрока два\n');
    expect(await page.locator('.note-editor').innerHTML()).not.toContain('<div><br></div>');
  });
});

// ───────────────────────── структура редактора после вставки ─────────────────────────

test.describe('структура после вставки', () => {
  test('многострочная вставка в чек-лист даёт столько пунктов, сколько строк', async ({ page }) => {
    // Иначе список из 22 товаров становился ОДНИМ пунктом высотой в экран.
    await newNote(page);
    await page.keyboard.type('Закупка');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Список задач' }).click();
    await paste(page, 'Антенна\nКабель\nРазъём');
    await expect(page.locator('.note-editor ul.cl > li')).toHaveCount(3);
    await expect(page.locator('.note-editor ul.cl > li').nth(2)).toContainText('Разъём');
  });

  test('вставка в середину заголовка не оставляет жирный хвост', async ({ page }) => {
    // Хвост заголовка после вставленных блоков оставался «голым» текстом в
    // корне, а корень редактора красит такой текст 24-м жирным кеглем.
    await newNote(page);
    await page.keyboard.type('ЗаголовокХВОСТ');
    for (let i = 0; i < 'ХВОСТ'.length; i++) await page.keyboard.press('ArrowLeft');
    await paste(page, 'первая\nвторая');
    const strayBig = await page.evaluate(() => {
      const el = document.querySelector('.note-editor')!;
      let seenBlock = false;
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === Node.ELEMENT_NODE && ['DIV', 'P', 'UL', 'OL', 'H1', 'H2'].includes((n as Element).tagName)) {
          seenBlock = true;
          continue;
        }
        if (seenBlock && (n.textContent ?? '').trim() !== '') return n.textContent;
      }
      return null;
    });
    expect(strayBig, `голый текст после блока: ${strayBig}`).toBeNull();
    await expect(page.locator('.note-editor')).toContainText('ХВОСТ');
  });
});

// ───────────────────────── что видно вокруг заметки ─────────────────────────

test.describe('вставленное видно в приложении', () => {
  test('общий поиск находит текст вставленной таблицы и не показывает &nbsp;', async ({ page }) => {
    await newNote(page);
    await paste(page, WPS_TEXT, WPS_HTML);
    await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}/, { timeout: 5000 });
    await page.waitForTimeout(900);

    await openApp(page, '/search');
    await page.getByPlaceholder(/Поиск|Искать/i).fill('Джаммеры');
    const body = page.locator('#root');
    await expect(body).toContainText('Джаммеры');
    await expect(body, 'сущность показана как текст').not.toContainText('&nbsp;');
  });

  test('заметка из одной строки не переписывается при повторном открытии', async ({ page }) => {
    // Первая строка хранится «голой», без тегов, — и ветка переноса старых
    // markdown-заметок принимала такую заметку за markdown.
    await newNote(page);
    await paste(page, 'Партия 5 * 3 * 2 коробки');
    await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}/, { timeout: 5000 });
    await page.waitForTimeout(900);
    await page.reload();
    await page.waitForTimeout(600);
    expect(await lines(page)).toEqual(['Партия 5 * 3 * 2 коробки']);
    const size = await page.evaluate(() => {
      const el = document.querySelector('.note-editor')!;
      const n = el.firstChild;
      const probe = n && n.nodeType === Node.ELEMENT_NODE ? (n as Element) : el;
      return parseFloat(getComputedStyle(probe).fontSize);
    });
    expect(size, 'заголовок перестал быть заголовком').toBeGreaterThan(20);
  });

  test('картинка-обманка с чужим data: не попадает в заметку', async ({ page }) => {
    // У DOMPurify для data:-ссылок в <img> своя ветка, которая проходит
    // раньше нашего фильтра и пускала ЛЮБОЙ data:-URL — чужой блоб ложился
    // в базу и уезжал в синхронизацию.
    await newNote(page);
    await paste(
      page,
      'до\nпосле',
      `<p>до</p><img src="data:text/html,%3Ch1%3Ehi"><img src="data:application/javascript,alert(1)"><img src="data:image/svg+xml;base64,PHN2Zy8+"><p>после</p>`,
    );
    await expect(page.locator('.note-editor img')).toHaveCount(0);
    await expect(page.locator('.note-editor')).toContainText('до');
    await expect(page.locator('.note-editor')).toContainText('после');
  });
});

// ───────────────────────── объединённые ячейки ─────────────────────────

test.describe('объединённые ячейки', () => {
  test('rowspan не сдвигает следующую строку под чужие колонки', async ({ page }) => {
    // В живой заявке и спецификации объединённые ячейки есть почти всегда.
    // Без учёта rowspan вторая строка съезжала влево: «M» вставало под
    // «Джаммеры», «900» под «S» — читая заметку, принимаешь 900 за размер.
    await newNote(page);
    await paste(
      page,
      'таблица',
      `<table><tr><td rowspan="2">Джаммеры</td><td>S</td><td>800</td></tr><tr><td>M</td><td>900</td></tr></table>`,
    );
    const got = await lines(page);
    expect(got[0]).toBe('Джаммеры S 800');
    // Вторая строка начинается с пустого места под объединённой ячейкой.
    const second = await page.evaluate(() => {
      const d = document.querySelectorAll('.note-editor div');
      return d[d.length - 1]?.textContent ?? '';
    });
    expect(second.startsWith('\u00A0')).toBe(true);
    expect(second).toContain('M');
    expect(second).toContain('900');
  });

  test('colspan не ломает число колонок', async ({ page }) => {
    await newNote(page);
    await paste(
      page,
      'таблица',
      `<table><tr><td colspan="2">Заявка на ноябрь</td><td>2026</td></tr><tr><td>Антенна</td><td>5</td><td>шт</td></tr></table>`,
    );
    const got = await lines(page);
    expect(got[0]).toContain('Заявка на ноябрь');
    expect(got[0]).toContain('2026');
    expect(got[1]).toBe('Антенна 5 шт');
  });
});

// ───────────────────────── мелочи, которые видно ─────────────────────────

test.describe('вставка в текст', () => {
  test('пробел по краю вставки не теряется', async ({ page }) => {
    // Из браузера приоритетнее text/html, и срезанный по краю пробел
    // склеивал слова: «итого1200».
    await newNote(page);
    await page.keyboard.type('Заголовок');
    await page.keyboard.press('Enter');
    await page.keyboard.type('итого');
    await paste(page, ' 1200 ₽', '<span> 1200 ₽</span>');
    // Первая буква строки поднята автозаглавной — это своё поведение.
    expect(await lines(page)).toEqual(['Заголовок', 'Итого 1200 ₽']);
  });

  test('одно «отменить» снимает вставку', async ({ page }) => {
    // Вставка идёт одной командой insertHTML, поэтому снимается одним шагом
    // отмены. Сколько ИМЕННО откатит браузер, когда вставка разрезала блок,
    // решает он сам (Chrome при вставке таблицы прихватывает и последнее
    // набранное слово) — за это мы не отвечаем и не проверяем; важно, что
    // вставленное уходит, а заметка остаётся целой.
    await newNote(page);
    await page.keyboard.type('Заголовок');
    await page.keyboard.press('Enter');
    await page.keyboard.type('было');
    await paste(page, WPS_TEXT, WPS_HTML);
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForTimeout(200);
    const text = await page.locator('.note-editor').innerText();
    expect(text, `после отмены осталось: ${text}`).not.toContain('Джаммеры');
    expect(text).toContain('Заголовок');
  });

  test('вставленная строка не остаётся крупной и жирной', async ({ page }) => {
    // Chrome при insertHTML «сохраняет вид» куска: берёт вычисленный стиль
    // корня редактора (а корень нарисован стилем заголовка) и вешает его
    // инлайном. Вставленная строка выглядела 24-м жирным посреди тела, и до
    // перезагрузки это не лечилось — санитайз срезает style лишь при записи.
    await newNote(page);
    await page.keyboard.type('Заголовок');
    await page.keyboard.press('Enter');
    await page.keyboard.type('было ');
    await paste(page, 'первая\nвторая');
    expect(await page.locator('.note-editor').innerHTML()).not.toContain('style=');
    const size = await page.evaluate(() => {
      const d = document.querySelector('.note-editor div');
      return d ? parseFloat(getComputedStyle(d).fontSize) : null;
    });
    expect(size).toBeLessThan(20);
  });
});

// ───────────────────────── чек-лист в работе ─────────────────────────

test.describe('чек-лист', () => {
  test('новый пункт после отмеченного не отмечен', async ({ page }) => {
    // Браузер делит блок вместе с атрибутами, и data-done уезжало на новый
    // пункт: он появлялся зачёркнутым, а прогресс показывал «2 из 2» на
    // незакрытом деле. Самый ходовой жест в чек-листе.
    await newNote(page);
    await page.keyboard.type('Дела');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Список задач' }).click();
    await page.keyboard.type('Позвонить');
    const first = page.locator('.note-editor ul.cl > li').first();
    const box = (await first.boundingBox())!;
    await page.mouse.click(box.x + 10, box.y + box.height / 2);
    await expect(first).toHaveAttribute('data-done', '1');

    await page.locator('.note-editor ul.cl > li').first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Написать');
    const items = page.locator('.note-editor ul.cl > li');
    await expect(items).toHaveCount(2);
    await expect(items.nth(1)).not.toHaveAttribute('data-done', '1');
  });
});
