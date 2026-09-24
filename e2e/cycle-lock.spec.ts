import { test, expect, openApp } from './fixtures';

// Замок раздела «Женские дни»: с третьей неверной попытки — пауза. Ожидание
// звучит один раз и отсчитывает секунды: раньше к «Неверный код. Подождите
// 2 с» дописывалось « — подождите 2 с», и одна и та же фраза шла дважды.
// Отсчёт виден всю паузу, даже если новый код уже начали набирать: раньше
// ввод гасил его вместе с ошибкой, и «Открыть» стояла серой без объяснения.
test('неверный код: пауза одной фразой, с отсчётом до конца паузы, потом снова «попробуйте»', async ({ page }) => {
  await openApp(page, '/more/cycle');
  await page.evaluate(async () => {
    const repo = await import('/src/lib/cycle/cycleRepo.ts');
    const { hashPin } = await import('/src/lib/crypto.ts');
    await repo.ensureCycleSetup();
    await repo.updateCycleSettings({ lock: 'pin', pin: await hashPin('1234') });
  });
  await page.reload();

  const input = page.getByLabel('Код доступа');
  const open = page.getByRole('button', { name: 'Открыть', exact: true });
  for (let i = 0; i < 2; i++) {
    await input.fill('0000');
    await open.click();
    // Проверка кода асинхронная: поле очищается, когда она отработала.
    await expect(input).toHaveValue('');
  }
  // Ввод гасит прошлую ошибку, так что следующая — уже от третьей попытки.
  await input.fill('0000');
  await open.click();

  // Текст — из первого кадра, где он появился. Ожидающий expect тут не годится:
  // он дождался бы, пока хвост с отсчётом исчезнет сам, и дубль прошёл бы.
  const first = await page
    .waitForFunction(() => document.querySelector('[role="alert"]')?.textContent || null)
    .then((h) => h.jsonValue());
  expect(first).toMatch(/^Неверный код\. Подождите \d\u00A0с$/);
  // Пауза кончилась — зовём попробовать снова. Раньше здесь навсегда
  // оставалось «Подождите 2 с», хотя ждать уже было нечего.
  await expect(page.getByRole('alert')).toHaveText('Неверный код. Попробуйте ещё раз');

  // Четвёртая неверная — пауза 4 с, и новый код начали набирать, не дождавшись
  // её конца. Ввод гасит ошибку, и раньше вместе с ней пропадал отсчёт:
  // «Открыть» серая, а почему — не сказано.
  await input.fill('0000');
  await open.click();
  await expect(input).toHaveValue('');
  await input.fill('1234');
  await expect(page.getByRole('alert')).toHaveText(/^Неверный код\. Подождите \d\sс$/);
  await expect(open).toBeDisabled();
});
