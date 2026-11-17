import { test, expect, openApp } from './fixtures';
import type { Page } from '@playwright/test';

// Адрес, который никто не размечал ссылкой: набранный руками или вставленный
// простым текстом. Со страницы и из письма ссылка приезжает размеченной и
// работает с 1.51.0; из мессенджера в буфере лежит ТОЛЬКО text/plain, и такая
// же ссылка оставалась голым текстом — рядом с работающей.
//
// Опасность затеи ровно одна, и проверяется она здесь наравне с пользой:
// деловая заметка полна слов с точкой внутри («отчёт.pdf», «ст.3»), и если
// распознавать любую точку, список дел станет минным полем из золотых слов.
// Поэтому домен без протокола — только со зоной из списка (linkify.ts).

async function newNote(page: Page) {
  await openApp(page, '/notes/new');
  await page.locator('.note-editor').click();
}

function links(page: Page) {
  return page.locator('.note-editor a[href]');
}

test.describe('набранный адрес', () => {
  test('пробел после адреса делает его ссылкой', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Поставщик');
    await page.keyboard.press('Enter');
    await page.keyboard.type('vk.com/market/kabel-opt дешевле');
    await expect(links(page)).toHaveAttribute('href', 'https://vk.com/market/kabel-opt');
    await expect(links(page)).toHaveText('vk.com/market/kabel-opt');
    // Набранное ПОСЛЕ адреса в ссылку не приклеилось.
    await expect(page.locator('.note-editor')).toContainText('дешевле');
    expect(await links(page).count()).toBe(1);
  });

  test('почта становится ссылкой целиком, а не хвостом домена', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Счёт');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Счёт присылать на buh@zavod-sv.ru ждём');
    await expect(links(page)).toHaveAttribute('href', 'mailto:buh@zavod-sv.ru');
    await expect(links(page)).toHaveText('buh@zavod-sv.ru');
  });

  test('почта с начала строки: домен строчными, имя — как набрано', async ({ page }) => {
    // Первую букву строки поднимает в заглавную и сам iPhone, и редактор
    // (autocapitalize.ts). Домен от регистра не зависит и приводится к
    // строчным, а имя до @ — зависит по стандарту, и мы его не трогаем:
    // «Buh@zavod.ru» на вид непривычно, но письмо уйдёт туда, куда набрали.
    await newNote(page);
    await page.keyboard.type('Счёт');
    await page.keyboard.press('Enter');
    await page.keyboard.type('buh@Zavod-SV.ru ждём');
    await expect(links(page)).toHaveAttribute('href', 'mailto:Buh@zavod-sv.ru');
  });

  test('адрес последним словом ловится при уходе с заметки', async ({ page }) => {
    // Пробела за собой он не оставил, значит живое распознавание по пробелу
    // мимо. Если бы не ловили на уходе, самый частый случай — дописал адрес и
    // закрыл — не работал бы вовсе.
    await newNote(page);
    await page.keyboard.type('Смотреть');
    await page.keyboard.press('Enter');
    await page.keyboard.type('ozon.ru/product/kabel');
    await expect(links(page)).toHaveCount(0);
    await page.locator('.note-editor').evaluate((el: HTMLElement) => el.blur());
    await expect(links(page)).toHaveAttribute('href', 'https://ozon.ru/product/kabel');
  });

  test('слово с точкой ссылкой НЕ становится', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Документы');
    await page.keyboard.press('Enter');
    await page.keyboard.type('отчёт.pdf смета.xlsx ст.3 версия 1.50.0 готово');
    await page.locator('.note-editor').evaluate((el: HTMLElement) => el.blur());
    await expect(links(page)).toHaveCount(0);
  });

  test('распознавание переживает перезагрузку заметки', async ({ page }) => {
    await newNote(page);
    await page.keyboard.type('Кабель');
    await page.keyboard.press('Enter');
    await page.keyboard.type('vk.com/market и всё');
    await page.waitForTimeout(1200);
    await page.goto(page.url());
    await expect(links(page)).toHaveAttribute('href', 'https://vk.com/market', { timeout: 7000 });
  });

  test('«Отменить» после распознавания не ломает текст', async ({ page }) => {
    // Ссылку оборачиваем правкой DOM, а она в стек отмены браузера не попадает.
    // Проверяем не «отмена снимает ссылку» (этого и не обещаем), а что заметка
    // после отмены остаётся связным текстом без дублей и обрывков.
    await newNote(page);
    await page.keyboard.type('Заголовок');
    await page.keyboard.press('Enter');
    await page.keyboard.type('vk.com/market дальше');
    await page.getByRole('button', { name: 'Отменить' }).click();
    await page.waitForTimeout(200);
    const text = await page.locator('.note-editor').innerText();
    expect(text).toContain('Заголовок');
    expect(text.match(/vk\.com/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(text).not.toContain('vk.comvk.com');
  });
});

test.describe('адрес из простого текста', () => {
  test('ссылка из мессенджера вставляется ссылкой', async ({ page }) => {
    await newNote(page);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'Глянь https://t.me/kabel_opt и vk.com/market');
      document
        .querySelector('.note-editor')!
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(200);
    await expect(links(page)).toHaveCount(2);
    await expect(links(page).nth(0)).toHaveAttribute('href', 'https://t.me/kabel_opt');
    await expect(links(page).nth(1)).toHaveAttribute('href', 'https://vk.com/market');
  });

  test('колонки из буфера не ломаются распознаванием', async ({ page }) => {
    // Разделитель колонок — два неразрывных пробела; адрес в ячейке не должен
    // их съесть или сдвинуть.
    await newNote(page);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'Поставщик\tСайт\nКабельТорг\tvk.com/market');
      document
        .querySelector('.note-editor')!
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(200);
    const text = await page.locator('.note-editor').innerText();
    expect(text.split('\n').map((l) => l.replace(/[\s\u00A0]+/g, ' ').trim()).filter(Boolean))
      .toEqual(['Поставщик Сайт', 'КабельТорг vk.com/market']);
    await expect(links(page)).toHaveAttribute('href', 'https://vk.com/market');
  });
});
