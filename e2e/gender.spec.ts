import { test, expect, openApp } from './fixtures';

// Выбор пола — обязательный первый экран и единственный рубильник раздела
// «Женские дни». Здесь проверяются обе стороны: гейт нельзя обойти, а мужской
// профиль не встречает раздел нигде — ни в навигации, ни в настройке разделов,
// ни по прямому адресу.

// Чистый первый запуск идёт БЕЗ сидинга настроек, и язык берётся из браузера:
// headless-Chromium живёт с en-US, и после миграции i18n гейт честно открылся
// бы по-английски. Сценарий файла — русский пользователь, локаль фиксируем.
test.use({ locale: 'ru-RU' });

test('первый запуск закрыт выбором пола, выбор открывает приложение', async ({ page }) => {
  // Нарочно НЕ openApp: гейт проверяется именно на чистом первом запуске.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ваш пол' })).toBeVisible();

  // «Продолжить» заблокирована, пока выбор не сделан, — экран обязателен.
  const cont = page.getByRole('button', { name: 'Продолжить' });
  await expect(cont).toBeDisabled();

  await page.getByRole('radio', { name: 'Женский' }).click();
  await cont.click();

  // Гейт ушёл и больше не возвращается; дальше — обычный первый запуск (тур).
  await expect(page.getByRole('heading', { name: 'Ваш пол' })).toHaveCount(0);
  await expect(page.getByText('Всё в одном месте')).toBeVisible();
});

test('мужской профиль: раздела нет в настройке разделов и по прямому адресу', async ({ page }) => {
  await openApp(page, '/more/settings/sections', { gender: 'male' });
  // В зонах настройки разделов «Женских дней» не существует — ни видимых, ни
  // спрятанных (это сильнее, чем «скрыт по умолчанию» женского профиля).
  await expect(page.getByText('Женские дни')).toHaveCount(0);

  // Прямой адрес не открывает раздел, а тихо уводит на «Главную».
  await page.goto('/more/cycle');
  await expect(page.locator('h1').first()).not.toHaveText(/Женские дни/);
});

test('женский профиль: раздел доступен по прямому адресу', async ({ page }) => {
  await openApp(page, '/more/cycle');
  await expect(page.locator('h1').first()).toHaveText(/Женские дни/);
});
