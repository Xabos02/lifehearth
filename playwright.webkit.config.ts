import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Тот же набор, но на движке Safari.
//
// Основной прогон идёт в Chromium — он быстрее и ловит наши собственные
// регрессии. Но владелец и его семья живут в WebKit, и он в этом приложении
// уже дважды повёл себя иначе: пустое поле даты рисовал сегодняшним числом
// (человек решил, что срок стоит), и правило для псевдоэлемента поля даты до
// него доходило не так, как до Chromium.
//
// Отсюда второй конфиг: `npx playwright test --config=playwright.webkit.config.ts`
// — прогнать что-то конкретное там, где живут люди.
export default defineConfig({
  ...base,
  use: { ...base.use, browserName: 'webkit' },
  projects: [{ name: 'mobile-webkit' }],
});
