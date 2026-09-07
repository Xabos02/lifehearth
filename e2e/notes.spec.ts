import { test, expect, openApp } from './fixtures';
import type { Page } from '@playwright/test';

// Раздел заметок целиком: структура редактора, вставка, форматирование, папки.
//
// Заметка — один contenteditable, а не «поле заголовка + поле текста».
// Заголовок здесь это ведущий «голый» текст: стиль задаёт база .note-editor, а
// любой блочный тег его сбрасывает. Пока человек печатает руками, инвариант
// держится сам; вставка из буфера приносит чужую разметку и ломала его.


/** Кнопка форматирования из панели «Aa»: открывает панель, если та закрыта. */
async function fmtBtn(page: Page, name: string) {
  const btn = page.getByRole('button', { name, exact: true });
  if (!(await btn.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Формат' }).click();
  }
  await btn.click();
}

async function newNote(page: Page) {
  await openApp(page, '/notes/new');
  await page.locator('.note-editor').click();
}

/** Вставка через синтетическое событие: реальный буфер обмена в headless
 *  недоступен, а обработчик приложения слушает именно paste. */
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

/** Кегль первой строки. Заголовок крупный, тело — обычное. */
async function firstLineSize(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('.note-editor')!;
    const n = el.firstChild;
    const probe = n && n.nodeType === Node.ELEMENT_NODE ? (n as Element) : el;
    return parseFloat(getComputedStyle(probe).fontSize);
  });
}

test.describe('заголовок заметки', () => {
  test('набранный руками — крупный', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Заголовок руками');
    expect(await firstLineSize(page)).toBeGreaterThan(20);
  });

  // Каждый источник кладёт в буфер свою разметку, и раньше половина из них
  // молча превращала заголовок в обычный текст.
  const SOURCES: [string, string | undefined][] = [
    ['мессенджер (только текст)', undefined],
    ['браузер', '<div>Заголовок из буфера</div>'],
    ['редактор документов', '<p>Заголовок из буфера</p>'],
    ['мелкий шрифт в источнике', '<span style="font-size:11px">Заголовок из буфера</span>'],
    ['несколько строк', '<div>Заголовок из буфера</div><div>Вторая строка</div>'],
  ];
  for (const [label, html] of SOURCES) {
    test(`вставка: ${label} — тоже крупный`, async ({ page }) => {
      await newNote(page);
      await paste(page, 'Заголовок из буфера', html);
      expect(await firstLineSize(page)).toBeGreaterThan(20);
    });
  }

  test('вставка нескольких строк оставляет тело обычным', async ({ page }) => {
    // Обратная проверка: развернуть ведущий блок — не значит развернуть всё.
    await newNote(page);
    await paste(page, 'Заголовок\nВторая', '<div>Заголовок</div><div>Вторая строка</div>');
    const bodySize = await page.evaluate(() => {
      const el = document.querySelector('.note-editor')!;
      const body = el.querySelector('div');
      return body ? parseFloat(getComputedStyle(body).fontSize) : null;
    });
    expect(bodySize).toBeLessThan(20);
  });

  test('заметка со списка не ломается', async ({ page }) => {
    // Если заметка начинается со списка, заголовка у неё просто нет —
    // вытаскивать первый пункт наружу ради заголовка нельзя.
    await newNote(page);
    await paste(page, 'Первый', '<ul><li>Первый</li><li>Второй</li></ul>');
    const items = await page.locator('.note-editor li').count();
    expect(items).toBe(2);
  });
});

test.describe('папки', () => {
  test('создать папку, перенести заметку, вернуться в общий список', async ({ page }) => {
    // Полный путь человека: у него уже есть заметка, он заводит папку и
    // раскладывает. Проверяем именно связку, а не отдельные экраны.
    await newNote(page);
    await page.keyboard.type('Договор с поставщиком');
    await page.waitForTimeout(900); // автосохранение
    await openApp(page, '/notes');

    await page.getByRole('button', { name: 'Новая папка' }).click();
    await page.getByPlaceholder('Например, «Работа»').fill('Работа');
    await page.getByRole('button', { name: 'Создать папку' }).click();
    await expect(page.getByText('Работа')).toBeVisible();

    // Долгое нажатие по заметке — перенос.
    const row = page.getByText('Договор с поставщиком').first();
    await row.hover();
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect(page.getByText('Куда перенести?')).toBeVisible();

    await page.getByRole('button', { name: /Работа/ }).click();
    await expect(page.getByText('Куда перенести?')).toHaveCount(0);

    // Заметка ушла из корня в папку.
    await expect(page.getByText('Договор с поставщиком')).toHaveCount(0);
    await page.getByRole('button', { name: /Работа/ }).click();
    await expect(page.getByText('Договор с поставщиком')).toBeVisible();
  });

  test('поиск ищет по всем заметкам, а не по открытой папке', async ({ page }) => {
    // Поиск, молча ограниченный невидимой папкой, читается как «заметка
    // пропала» — это худшее, что может сделать раздел с заметками.
    await newNote(page);
    await page.keyboard.type('Уникальное слово фонарь');
    await page.waitForTimeout(900);
    await openApp(page, '/notes');
    await page.getByPlaceholder(/Поиск/i).fill('фонарь');
    await expect(page.getByText('Уникальное слово фонарь')).toBeVisible();
  });

  test('поиск находит заметку, УБРАННУЮ в папку, из общего списка', async ({ page }) => {
    // Тест выше эту поломку не ловил: он ищет заметку, лежащую в корне, и
    // корневой список не пуст. А ветка пустого состояния проверяла именно его —
    // стоило разложить всё по папкам, и поиск по любому слову рисовал «Пока нет
    // заметок» вместо найденного.
    await newNote(page);
    await page.keyboard.type('Спрятанная заметка про якорь');
    await page.waitForTimeout(900);
    await openApp(page, '/notes');

    await page.getByRole('button', { name: 'Новая папка' }).click();
    await page.getByPlaceholder('Например, «Работа»').fill('Архив');
    await page.getByRole('button', { name: 'Создать папку' }).click();

    // Долгим нажатием отправляем единственную заметку в папку — корень пустеет.
    const row = page.getByText('Спрятанная заметка про якорь').first();
    await row.hover();
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.getByRole('button', { name: /Архив/ }).click();
    // Корневой список заметок пуст (папка с заметкой — не в счёт: экран с
    // папками больше не притворяется пустым).
    await expect(page.getByText('Спрятанная заметка про якорь')).toHaveCount(0);

    // И ищем её из корня.
    await page.getByPlaceholder(/Поиск/i).fill('якорь');
    await expect(page.getByText('Пока нет заметок')).toHaveCount(0);
    await expect(page.getByText('Спрятанная заметка про якорь')).toBeVisible();
  });

  test('стрелка «Назад» на экране «Куда перенести?» возвращает к списку', async ({ page }) => {
    // Экран переноса — состояние внутри /notes, а не отдельный маршрут. Ссылка
    // на собственный адрес компонент не размонтирует: стрелка выглядела рабочей
    // и не делала ничего, а «Отмена» лежит под длинным списком папок.
    await newNote(page);
    await page.keyboard.type('Заметка для переноса');
    await page.waitForTimeout(900);
    await openApp(page, '/notes');

    const row = page.getByText('Заметка для переноса').first();
    await row.hover();
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect(page.getByRole('heading', { name: 'Куда перенести?' })).toBeVisible();

    await page.getByRole('button', { name: 'Назад' }).click();
    await expect(page.getByRole('heading', { name: 'Куда перенести?' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Заметки' })).toBeVisible();
  });

  test('удаление папки не удаляет заметки', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Важная заметка внутри папки');
    await page.waitForTimeout(900);
    await openApp(page, '/notes');
    await page.getByRole('button', { name: 'Новая папка' }).click();
    await page.getByPlaceholder('Например, «Работа»').fill('Временная');
    await page.getByRole('button', { name: 'Создать папку' }).click();

    const row = page.getByText('Важная заметка внутри папки').first();
    await row.hover();
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.getByRole('button', { name: /Временная/ }).click();

    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: /Временная/ }).click();
    await page.getByRole('button', { name: 'Изменить' }).click();
    await page.getByRole('button', { name: 'Удалить папку' }).click();
    await page.waitForTimeout(500);

    // Заметка вернулась в общий список, а не исчезла вместе с папкой.
    await expect(page.getByText('Важная заметка внутри папки')).toBeVisible();
  });
});

test.describe('редактор', () => {
  test('чек-лист: создаётся, отмечается тапом, переживает перезагрузку', async ({ page }) => {
    // Список дел — главное, чего в редакторе не было. Проверяем весь путь:
    // кнопка, ввод, отметка галочкой и сохранение состояния.
    await newNote(page);
    await page.keyboard.type('Покупки');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Список задач' }).click();
    await page.keyboard.type('Молоко');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Хлеб');
    await expect(page.locator('.note-editor ul.cl > li')).toHaveCount(2);

    // Тап по галочке первого пункта — по левому краю, где она нарисована.
    const first = page.locator('.note-editor ul.cl > li').first();
    const box = (await first.boundingBox())!;
    await page.mouse.click(box.x + 10, box.y + box.height / 2);
    await expect(first).toHaveAttribute('data-done', '1');

    // Отметка обязана пережить сохранение: она в атрибуте, а санитайзер режет
    // всё, чего нет в списке разрешённых.
    await page.waitForTimeout(900);
    await page.reload();
    await page.waitForTimeout(900);
    await expect(page.locator('.note-editor ul.cl > li[data-done="1"]')).toHaveCount(1);
  });

  test('тап по тексту пункта ставит каретку, а не отмечает', async ({ page }) => {
    // Зона галочки узкая намеренно: шире — и она начнёт перехватывать тапы по
    // тексту, когда человек хочет просто поправить слово.
    await newNote(page);
    await page.keyboard.type('Дела');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Список задач' }).click();
    await page.keyboard.type('Позвонить в банк');
    const li = page.locator('.note-editor ul.cl > li').first();
    const box = (await li.boundingBox())!;
    await page.mouse.click(box.x + box.width - 12, box.y + box.height / 2);
    await expect(li).not.toHaveAttribute('data-done', '1');
  });

  test('подзаголовок и цитата включаются и выключаются', async ({ page }) => {
    // Без повторного нажатия из блочного формата нельзя выйти, не удаляя
    // строку — это и была бы ловушка.
    await newNote(page);
    await page.keyboard.type('Заметка');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Раздел');
    await fmtBtn(page, 'Подзаголовок');
    await expect(page.locator('.note-editor h2')).toHaveCount(1);
    await fmtBtn(page, 'Подзаголовок');
    await expect(page.locator('.note-editor h2')).toHaveCount(0);

    await fmtBtn(page, 'Цитата');
    await expect(page.locator('.note-editor blockquote')).toHaveCount(1);
    await fmtBtn(page, 'Цитата');
    await expect(page.locator('.note-editor blockquote')).toHaveCount(0);
  });

  test('зачёркнутый текст сохраняется', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Заголовок');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Отменённый пункт');
    // Выделяем ровно набранную строку посимвольно. Shift+Home трактуется
    // движками по-разному: часть браузеров тянет выделение до начала
    // документа и захватывает заголовок — тогда зачёркнутым оказывается не
    // то, что проверяет тест.
    for (let i = 0; i < 'Отменённый пункт'.length; i++) {
      await page.keyboard.press('Shift+ArrowLeft');
    }
    await fmtBtn(page, 'Зачёркнутый');
    await page.waitForTimeout(900);
    await page.reload();
    await page.waitForTimeout(900);
    // Проверяем смысл, а не разметку: важно, что весь выделенный текст
    // остался зачёркнутым после перезагрузки. Число тегов — деталь движка
    // (одни браузеры дают один <s>, другие дробят на несколько), и привязка
    // к нему делала тест ложно-красным там, где с заметкой всё в порядке.
    await expect
      .poll(async () =>
        page
          .locator('.note-editor s, .note-editor strike')
          .allInnerTexts()
          .then((parts) => parts.join('').replace(/\s+/g, ' ').trim()),
      )
      .toBe('Отменённый пункт');
  });

  test('кнопка списка не уносит каретку в начало строки', async ({ page }) => {
    // execCommand пересобирает блок и ставит каретку в НАЧАЛО нового
    // контейнера. Из-за этого «написал строку → нажал список → продолжил
    // набор» дописывало текст ПЕРЕД уже написанным: «Покупки» + «молоко»
    // давало «МолокоПокупки» одним пунктом.
    await newNote(page);
    await page.keyboard.type('Заголовок');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Покупки');
    await fmtBtn(page, 'Маркированный список');
    await page.keyboard.type(' на неделю');
    const item = await page.locator('.note-editor li').first().textContent();
    expect(item).toBe('Покупки на неделю');
  });

  test('второй пункт списка начинается с заглавной буквы', async ({ page }) => {
    // Клавиатура iOS капитализирует по пунктуации: заглавная идёт после точки.
    // В списке точек нет — люди пишут пункты без них, — и второй пункт начинался
    // со строчной, хотя каждый пункт это отдельное предложение.
    await newNote(page);
    await page.keyboard.type('Покупки');
    await page.keyboard.press('Enter'); // заголовок остаётся заголовком
    await fmtBtn(page, 'Маркированный список');
    await page.keyboard.type('молоко');
    await page.keyboard.press('Enter');
    await page.keyboard.type('хлеб');
    await page.keyboard.press('Enter');
    await page.keyboard.type('сыр');

    const items = await page.locator('.note-editor li').allTextContents();
    expect(items).toEqual(['Молоко', 'Хлеб', 'Сыр']);
  });

  test('регистр в СЕРЕДИНЕ строки не трогаем', async ({ page }) => {
    // Обратная сторона: подниматься должна только первая буква строки. Иначе
    // «и т.д.» превратилось бы в «И т.Д.», а это хуже, чем строчная в начале.
    await newNote(page);
    await page.keyboard.type('Заголовок');
    await page.keyboard.press('Enter');
    await fmtBtn(page, 'Маркированный список');
    await page.keyboard.type('купить хлеб и молоко');
    const item = await page.locator('.note-editor li').first().textContent();
    expect(item).toBe('Купить хлеб и молоко');
  });

  test('первая строка заметки тоже с заглавной', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('заголовок заметки');
    await expect(page.locator('.note-editor')).toContainText('Заголовок заметки');
  });

  test('блочная команда с начала строки не утаскивает текст в заголовок', async ({ page }) => {
    // Самое дорогое, что нашёл предполётный аудит, и внёс это я сам, когда чинил
    // прыжок каретки. Смещение по видимому тексту на границе строк
    // неоднозначно: «конец строки N» и «начало строки N+1» — одно число, а
    // восстановление разрешало ничью в пользу предыдущей строки. Предыдущая
    // строка часто и есть заголовок: в списке заметок появлялось «Покупкихлеб».
    await newNote(page);
    await page.keyboard.type('Заголовок');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Покупки');
    await page.keyboard.press('Home'); // каретка в начало строки
    await fmtBtn(page, 'Маркированный список');
    await page.keyboard.type('хлеб');

    const html = await page.locator('.note-editor').innerHTML();
    expect(html, `заголовок испорчен: ${html}`).toContain('Заголовок<');
    expect(html).not.toContain('Заголовокхлеб');
    expect(html).not.toContain('ЗаголовокХлеб');
  });

  test('автозаглавную можно отменить — «iPhone» пишется как надо', async ({ page }) => {
    // Без отмены строку НЕЛЬЗЯ начать со строчной вообще: «iPhone» → «IPhone»,
    // почта → «Vladislaveeet@gmail.com», «sso-mil.ru» → «Sso-mil.ru». Стереть и
    // набрать заново не помогало — поднимало снова. iOS так не делает: она
    // запоминает отказ.
    await newNote(page);
    await page.keyboard.type('Товары');
    await page.keyboard.press('Enter');
    await page.keyboard.type('i');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('iPhone 15');
    await expect(page.locator('.note-editor')).toContainText('iPhone 15');
    await expect(page.locator('.note-editor')).not.toContainText('IPhone');
  });

  test('почта в начале строки не капитализируется после отмены', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Контакты');
    await page.keyboard.press('Enter');
    await page.keyboard.type('v');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('vladislaveeet@gmail.com');
    await expect(page.locator('.note-editor')).toContainText('vladislaveeet@gmail.com');
  });

  test('кнопка «Список задач» тоже не уносит каретку', async ({ page }) => {
    // Правка каретки жила внутри exec(), а чек-лист вызывается своим
    // обработчиком — и проходил мимо. Получалось, что одна кнопка списка
    // чинена, а соседняя, самая ходовая, нет.
    await newNote(page);
    await page.keyboard.type('Дела');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Купить');
    await page.getByRole('button', { name: 'Список задач' }).click();
    await page.keyboard.type(' хлеб');

    const item = await page.locator('.note-editor li').first().textContent();
    expect(item).toBe('Купить хлеб');
  });

  test('вставка из веба не приносит чужие классы', async ({ page }) => {
    // В конфиге санитайзера стоял ALLOWED_CLASSES — такой опции у DOMPurify
    // нет вовсе (она из sanitize-html), и незнакомые ключи он молча
    // игнорирует. То есть class проходил целиком, а приложение на Tailwind с
    // глобальными утилитами: фрагмент с class="hidden" давал сохранённый, но
    // невидимый текст, class="fixed inset-0 z-50" — блок поверх экрана.
    await newNote(page);
    await page.keyboard.type('Заголовок');
    await paste(
      page,
      'вставленный текст',
      '<p class="hidden">вставленный текст</p><div class="fixed inset-0 z-50">поверх</div>',
    );

    const html = await page.locator('.note-editor').innerHTML();
    expect(html, `чужие классы уцелели: ${html}`).not.toContain('hidden');
    expect(html).not.toContain('fixed');

    // И текст при этом видно — санитайз чистит атрибут, а не содержимое.
    await expect(page.getByText('вставленный текст')).toBeVisible();
  });

  test('класс чек-листа санитайз переживает', async ({ page }) => {
    // Обратная сторона: единственный класс, который нужен приложению, обязан
    // остаться — иначе чек-лист после сохранения перестанет быть чек-листом.
    await newNote(page);
    await page.keyboard.type('Список');
    await page.getByRole('button', { name: 'Список задач' }).click();
    await page.keyboard.type('пункт');
    await page.waitForTimeout(900);
    await page.reload();
    await expect(page.locator('.note-editor ul.cl')).toHaveCount(1);
  });

  test('панель форматирования не выталкивает страницу вбок', async ({ page }) => {
    // Кнопок стало девять, в ширину телефона они не помещаются. Прокручиваться
    // должна панель, а не страница.
    await newNote(page);
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(scrollable).toBe(false);
  });
});

test.describe('низ заметки не прячется под панелью', () => {
  test('длинную заметку можно доскроллить: последняя строка видна над панелью форматирования', async ({
    page,
  }) => {
    await newNote(page);
    // Достаточно строк, чтобы контент гарантированно ушёл за экран 660px.
    // Вставляем как HTML: plain-text не порождает блочных строк в contenteditable.
    const lines = Array.from({ length: 60 }, (_, i) => `Строка ${i + 1}`);
    await paste(page, lines.join('\n'), 'Заголовок' + lines.map((l) => `<div>${l}</div>`).join(''));
    await page.keyboard.press('Escape'); // убрать фокус — интересует чистый скролл, без каретки

    // Скроллим контейнер до упора вниз — как палец, доводящий заметку до конца.
    await page.evaluate(() => {
      const s = document.getElementById('app-scroll')!;
      s.scrollTop = s.scrollHeight;
    });
    await page.waitForTimeout(200);

    const gap = await page.evaluate(() => {
      const blocks = document.querySelectorAll('.note-editor > div');
      const last = blocks[blocks.length - 1]!.getBoundingClientRect();
      // Панель — fixed-элемент с кнопками форматирования; ищем по ref-классам
      // ненадёжно, берём её как ближайший fixed к низу с кнопками внутри.
      // Панель — fixed у самого низа И невысокая: фильтр по top отсекает
      // fixed-каркас всего приложения (он тоже прибит к низу, но top=0).
      const toolbar = [...document.querySelectorAll('div')].find((d) => {
        if (getComputedStyle(d).position !== 'fixed' || !d.querySelector('button')) return false;
        const r = d.getBoundingClientRect();
        return r.bottom >= window.innerHeight - 1 && r.top > window.innerHeight * 0.6;
      })!;
      return toolbar.getBoundingClientRect().top - last.bottom;
    });
    // Последняя строка целиком ВЫШЕ верха панели — раньше распорки не было,
    // и низ заметки физически нельзя было увидеть.
    expect(gap).toBeGreaterThanOrEqual(0);
  });
});

test.describe('вставка простого текста — буквально', () => {
  test('символы разметки из буфера не интерпретируются как HTML', async ({ page }) => {
    await newNote(page);
    // Типичный фрагмент из ответа ИИ: угловые скобки, амперсанд, числовая
    // сущность. Всё это обязано отобразиться ровно как скопировано.
    await paste(page, 'Заголовок\nусловие a<b и b>c\nкоманда <script>нет</script>\nсущность &#8594; и &amp;');
    const text = await page.locator('.note-editor').innerText();
    expect(text).toContain('a<b и b>c');
    expect(text).toContain('<script>нет</script>');
    expect(text).toContain('&#8594;');
    expect(text).toContain('&amp;');
  });
});

// Фото и файлы в заметке. Фото — инлайн в тексте (сжатый JPEG dataURL, как в
// чате), файлы — вложения чанками в noteFiles (лимит D1-колонки — 2 МБ на
// запись синка, файл целиком в неё не лезет).
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('фото и файлы в заметке', () => {
  test('заметка из одного фото сохраняется и переживает перезагрузку', async ({ page }) => {
    await newNote(page);
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'фото.png', mimeType: 'image/png', buffer: PNG_1PX });
    // Сжатие кладёт фото в текст встроенным JPEG.
    await expect(page.locator('.note-editor img')).toHaveAttribute('src', /^data:image\//);
    // Автосейв обязан сохранить заметку БЕЗ текста: фото — уже содержимое.
    await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}/, { timeout: 5000 });
    await page.reload();
    await expect(page.locator('.note-editor img')).toHaveAttribute('src', /^data:image\//);
  });

  test('внешняя картинка отрезается санитайзом, встроенная остаётся', async ({ page }) => {
    await newNote(page);
    const inline = `data:image/png;base64,${PNG_1PX.toString('base64')}`;
    await paste(
      page,
      'Заголовок',
      `<div>Заголовок</div><img src="https://evil.example/pixel.png"><img src="${inline}">`,
    );
    // Чужой URL — трекинг-пиксель или битая без сети картинка; встроенная —
    // легитимное фото. Санитайз обязан отличать одно от другого.
    await expect(page.locator('.note-editor img')).toHaveCount(1);
    await expect(page.locator('.note-editor img')).toHaveAttribute('src', /^data:image\//);
    await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}/, { timeout: 5000 });
    await page.reload();
    await expect(page.locator('.note-editor img')).toHaveCount(1);
    await expect(page.locator('.note-editor img')).toHaveAttribute('src', /^data:image\//);
  });

  test('картинка через ту же кнопку уходит в текст, а не вложением', async ({ page }) => {
    // Кнопка вложения одна на всё: куда попадёт выбранное, решает тип файла.
    // Раньше кнопок было две, и обе открывали одинаковое системное меню iOS —
    // выбранное через «Файл» фото приезжало карточкой вложения вместо текста.
    await newNote(page);
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'снимок.png', mimeType: 'image/png', buffer: PNG_1PX });

    await expect(page.locator('.note-editor img')).toHaveAttribute('src', /^data:image\//);
    await expect(page.getByTestId('note-attachments')).toHaveCount(0);
  });

  test('файл прикладывается карточкой, переживает перезагрузку и удаляется', async ({ page }) => {
    await newNote(page);
    await page
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'отчёт.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('привет из файла', 'utf8'),
      });
    const card = page.getByTestId('note-attachments');
    await expect(card).toContainText('отчёт.txt');
    await expect(card).toContainText('Текст');
    // Вложение к пустой заметке создаёт саму заметку — иначе файлу не к чему
    // прикрепиться и перезагрузка его потеряла бы.
    await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}/, { timeout: 5000 });
    await page.reload();
    await expect(page.getByTestId('note-attachments')).toContainText('отчёт.txt');

    page.on('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Удалить отчёт.txt' }).click();
    await expect(page.getByTestId('note-attachments')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.note-editor')).toBeVisible();
    await expect(page.getByTestId('note-attachments')).toHaveCount(0);
  });
});

// Вложенные папки — как в Apple Notes: папка создаётся на текущем уровне,
// каждый экран показывает один уровень, назад ведёт к родителю, содержимое
// удалённой папки поднимается на уровень выше.
test.describe('вложенные папки', () => {
  async function makeFolder(page: Page, name: string, label = 'Новая папка') {
    await page.getByRole('button', { name: label }).click();
    await page.getByPlaceholder('Например, «Работа»').fill(name);
    await page.getByRole('button', { name: 'Создать папку' }).click();
  }

  test('папка в папке: создание, заметка внутри, навигация по уровням', async ({ page }) => {
    await openApp(page, '/notes');
    await makeFolder(page, 'Работа');
    await page.getByRole('button', { name: /Работа/ }).click();
    // Внутри папки той же кнопкой создаётся вложенная.
    await makeFolder(page, 'Проекты', 'Новая вложенная папка');
    await page.getByRole('button', { name: /Проекты/ }).click();

    // Заметка, созданная из подпапки, попадает в подпапку.
    await page.getByRole('button', { name: 'Добавить' }).click();
    await page.locator('.note-editor').click(); // дождаться редактор и фокус
    await page.keyboard.type('План RTE');
    await page.waitForTimeout(900); // автосохранение
    await page.getByRole('link', { name: /Назад/ }).click(); // назад из редактора
    await expect(page.getByText('План RTE')).toBeVisible();

    // Назад — по уровням: из «Проекты» в «Работа», оттуда в корень.
    await page.getByRole('button', { name: /Работа/ }).click();
    await expect(page.getByText('План RTE')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Проекты/ })).toBeVisible();
    await page.getByRole('button', { name: /Все заметки/ }).click();
    // В корне видна только корневая папка, вложенная не светится, а её
    // счётчик считает заметку в глубине.
    await expect(page.getByRole('button', { name: /Работа/ })).toContainText('1');
    await expect(page.getByRole('button', { name: /Проекты/ })).toHaveCount(0);

    // Структура переживает перезагрузку.
    await page.reload();
    await page.getByRole('button', { name: /Работа/ }).click();
    await page.getByRole('button', { name: /Проекты/ }).click();
    await expect(page.getByText('План RTE')).toBeVisible();
  });

  test('удаление папки поднимает заметки и подпапки на уровень выше', async ({ page }) => {
    await openApp(page, '/notes');
    await makeFolder(page, 'Родитель');
    await page.getByRole('button', { name: /Родитель/ }).click();
    await makeFolder(page, 'Вложенная', 'Новая вложенная папка');

    // Заметка прямо в «Родителе».
    await page.getByRole('button', { name: 'Добавить' }).click();
    await page.locator('.note-editor').click(); // дождаться редактор и фокус
    await page.keyboard.type('Заметка родителя');
    await page.waitForTimeout(900);
    await page.getByRole('link', { name: /Назад/ }).click();

    page.on('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Изменить' }).click();
    await page.getByRole('button', { name: 'Удалить папку' }).click();

    // Мы в корне; вложенная папка стала корневой, заметка — в общем списке.
    await expect(page.getByRole('button', { name: /Родитель/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Вложенная/ })).toBeVisible();
    await expect(page.getByText('Заметка родителя')).toBeVisible();
  });

  test('перенос заметки в подпапку — всё дерево в одном списке', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Кочующая заметка');
    await page.waitForTimeout(900);
    await openApp(page, '/notes');
    await makeFolder(page, 'Верх');
    await page.getByRole('button', { name: /Верх/ }).click();
    await makeFolder(page, 'Глубина', 'Новая вложенная папка');
    await page.getByRole('button', { name: /Все заметки/ }).click();

    // Долгое нажатие — перенос; подпапка доступна из дерева сразу, без
    // проваливания по уровням.
    const row = page.getByText('Кочующая заметка').first();
    await row.hover();
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect(page.getByText('Куда перенести?')).toBeVisible();
    await page.getByRole('button', { name: /Глубина/ }).click();

    await page.getByRole('button', { name: /Верх/ }).click();
    await page.getByRole('button', { name: /Глубина/ }).click();
    await expect(page.getByText('Кочующая заметка')).toBeVisible();
  });

  test('перенос папки в другую: содержимое едет с ней, себя в целях нет', async ({ page }) => {
    // Путь человека: два корневых раздела, один решил вложить в другой.
    // Раньше это было невозможно — только создать новую на месте.
    await openApp(page, '/notes');
    await makeFolder(page, 'Архив');
    await makeFolder(page, 'Работа');
    await page.getByRole('button', { name: /Работа/ }).click();
    // Заметка внутри переносимой папки — поедет вместе с ней.
    await page.getByRole('button', { name: 'Добавить' }).click();
    await page.locator('.note-editor').click();
    await page.keyboard.type('Договор аренды');
    await page.waitForTimeout(900);
    await page.getByRole('link', { name: /Назад/ }).click();

    await page.getByRole('button', { name: 'Изменить' }).click();
    await page.getByRole('button', { name: 'Переместить папку' }).click();
    await expect(page.getByRole('heading', { name: 'Куда перенести?' })).toBeVisible();
    // Сама «Работа» целью не предлагается — вложить папку в себя нельзя.
    await expect(page.getByRole('button', { name: /Работа/ })).toHaveCount(0);
    await page.getByRole('button', { name: /Архив/ }).click();

    // Экран остался на «Работе», но назад теперь ведёт в «Архив».
    await page.getByRole('button', { name: /Архив/ }).click();
    await expect(page.getByRole('button', { name: /Работа/ })).toBeVisible();
    await page.getByRole('button', { name: /Работа/ }).click();
    await expect(page.getByText('Договор аренды')).toBeVisible();

    // В корне «Работы» больше нет, счётчик «Архива» видит заметку в глубине.
    await page.getByRole('button', { name: /Архив/ }).click(); // назад из «Работы»
    await page.getByRole('button', { name: /Все заметки/ }).click();
    await expect(page.getByRole('button', { name: /Работа/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Архив/ })).toContainText('1');
  });
});

// Полоса редактора — как в Apple Notes: несколько входов без горизонтального
// скролла, стили текста собраны за кнопкой «Aa». Вложение одно на всё: две
// кнопки открывали одинаковое системное меню и путали.
test.describe('панель инструментов', () => {
  test('полоса помещается без скролла, «Aa» открывает и закрывает стили', async ({ page }) => {
    await newNote(page);
    // Кнопки полосы видны сразу.
    for (const name of ['Формат', 'Список задач', 'Вложить', 'Отменить']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    // Контейнер полосы не скроллится вбок.
    const overflow = await page.evaluate(() => {
      const bar = document.querySelector('[aria-label="Формат"]')!.parentElement!;
      return bar.scrollWidth - bar.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);

    // Стили спрятаны, пока «Aa» не нажата.
    await expect(page.getByTestId('format-panel')).toHaveCount(0);
    await page.getByRole('button', { name: 'Формат' }).click();
    await expect(page.getByTestId('format-panel')).toBeVisible();
    // Слова-стили с собственной типографикой + начертания и списки.
    for (const name of ['Подзаголовок', 'Обычный текст', 'Цитата', 'Жирный', 'Курсив', 'Зачёркнутый', 'Маркированный список', 'Нумерованный список']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Формат' }).click();
    await expect(page.getByTestId('format-panel')).toHaveCount(0);
  });

  test('жирный из панели «Aa» применяется и сохраняется', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Заголовок');
    await page.keyboard.press('Enter');
    await page.keyboard.type('важное слово');
    // Выделяем ровно набранную строку: Shift+Home в части движков тянет
    // выделение до начала документа и захватывает заголовок.
    for (let i = 0; i < 'важное слово'.length; i++) {
      await page.keyboard.press('Shift+ArrowLeft');
    }
    await fmtBtn(page, 'Жирный');
    await page.waitForTimeout(900);
    await page.reload();
    await page.waitForTimeout(400);
    // Смысл вместо разметки: важно, что нужный текст жирный и пережил
    // перезагрузку, а не сколько тегов создал движок.
    await expect
      .poll(async () =>
        page
          .locator('.note-editor b, .note-editor strong')
          .allInnerTexts()
          .then((parts) => parts.join('').replace(/\s+/g, ' ').trim()),
      )
      // Первая буква строки поднимается в заглавную самим редактором —
      // ожидаем ровно то, что человек видит на экране.
      .toBe('Важное слово');
  });

  test('«Обычный» возвращает заголовок к тексту', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Заметка');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Раздел');
    await fmtBtn(page, 'Подзаголовок');
    await expect(page.locator('.note-editor h2')).toHaveCount(1);
    await fmtBtn(page, 'Обычный текст');
    await expect(page.locator('.note-editor h2')).toHaveCount(0);
  });
});

test.describe('карточка списка', () => {
  test('превью: первая строка режется только когда она и есть заголовок', async ({ page }) => {
    await openApp(page, '/notes');
    await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts');
      const ts = new Date().toISOString();
      await db.notes.bulkPut([
        // Обычная заметка редактора: заголовок = первая строка контента.
        {
          id: 'pv1', createdAt: ts, updatedAt: ts, deletedAt: null,
          title: 'Список покупок',
          content: '<p>Список покупок</p><p>молоко, хлеб, сыр</p>',
          tags: [], pinned: false, folderId: null,
        },
        // Заметка с собственным именем: контент начинается сразу с сути.
        {
          id: 'pv2', createdAt: ts, updatedAt: ts, deletedAt: null,
          title: 'Поставщик',
          content: '<p>Предоплата 100%, отгрузка из Люберец</p>',
          tags: [], pinned: false, folderId: null,
        },
      ] as never[]);
    });
    await page.reload();

    // У обычной — превью без дубля заголовка: текст после первой строки.
    const usual = page.locator('.card', { hasText: 'Список покупок' });
    await expect(usual.getByText('молоко, хлеб, сыр')).toBeVisible();
    await expect(usual.getByText('Список покупок')).toHaveCount(1);
    // У именованной — превью есть и начинается с первой строки контента.
    const named = page.locator('.card', { hasText: 'Поставщик' });
    await expect(named.getByText('Предоплата 100%')).toBeVisible();
  });
});

test('битая заметка не роняет весь список', async ({ page }) => {
  // Запись без content приезжает синком с устройства другой версии или из
  // восстановленной копии. Раньше первая такая заметка валила экран целиком
  // («Что-то пошло не так»): превью считалось через undefined.replace — и
  // человек терял доступ сразу ко всем своим заметкам, а не к одной битой.
  await openApp(page, '/notes');
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts');
    const ts = new Date().toISOString();
    await db.notes.bulkPut([
      // Без content вовсе — ровно то, что приезжает с чужой версии схемы.
      { id: 'broken1', createdAt: ts, updatedAt: ts, deletedAt: null, title: 'Без содержимого', tags: [], pinned: false, folderId: null },
      { id: 'ok1', createdAt: ts, updatedAt: ts, deletedAt: null, title: 'Целая заметка', content: '<p>Текст на месте</p>', tags: [], pinned: false, folderId: null },
    ] as never[]);
  });
  await page.goto('/notes');

  // Экран жив, и на нём обе заметки: битая не прячется и не мешает соседке.
  await expect(page.getByText('Что-то пошло не так')).toHaveCount(0);
  await expect(page.getByText('Целая заметка')).toBeVisible();
  await expect(page.getByText('Без содержимого')).toBeVisible();

  // Поиск по заметкам тоже переживает битую запись.
  await openApp(page, '/search');
  await page.getByPlaceholder('Искать везде…').fill('Текст');
  await expect(page.getByText('Что-то пошло не так')).toHaveCount(0);
  await expect(page.getByText('Целая заметка')).toBeVisible();
});
