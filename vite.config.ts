import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ command }) => ({
  // в dev — корень (удобнее для предпросмотра), в проде — путь GitHub Pages
  base: command === 'build' ? '/lifehearth/' : '/',
  // vitest берёт конфиг отсюда. e2e/** исключаем: там Playwright, и его
  // test() при запуске под vitest падает с «did not expect test() to be called
  // here» — два раннера на одном расширении .spec.ts.
  test: {
    // '**/node_modules/**', а не 'node_modules/**': во вложенном
    // worker/node_modules лежат собственные тесты чужих библиотек (blake3,
    // wrangler). Vitest подхватывал их и показывал «12 failed» — за этим
    // шумом не было видно, что два наших теста не запускаются вовсе.
    // .playwright — снимки экрана, они гоняются playwright'ом.
    exclude: ['**/node_modules/**', 'dist/**', 'e2e/**', '.playwright/**'],
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // autoUpdate (а не 'prompt'): на iOS-PWA ручное «Обновить» ненадёжно — юзер
      // застревал на старом кэше и не видел задеплоенных фиксов. Теперь новый SW
      // активируется сам (skipWaiting + clientsClaim) и страница перезагружается
      // на свежую версию без участия пользователя.
      registerType: 'autoUpdate',
      manifest: {
        name: 'LifeHearth',
        short_name: 'LifeHearth',
        description: 'Личный центр управления жизнью',
        lang: 'ru',
        start_url: '/lifehearth/',
        scope: '/lifehearth/',
        display: 'standalone',
        orientation: 'portrait',
        // theme_color красит системный хром (строка статуса на Android, полоса
        // над шапкой в standalone на iOS) — он должен совпадать с ВЕРХОМ
        // приложения, а верх это bg. Раньше здесь стоял цвет таб-бара, и
        // сверху получалась полоса на два тона светлее шапки.
        theme_color: '#0e0e15',
        // background_color — заставка до первого кадра, и она обязана
        // совпадать с заливкой html/body (см. index.css: --app-elevated),
        // иначе при запуске мигает полоса под таб-баром.
        background_color: '#1d1d27',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Приём «Поделиться» (Android/десктоп Chromium; iOS WebKit это не
        // поддерживает — там вход в /share идёт через ярлык Shortcuts и кнопку
        // «Вставить из буфера»). GET-навигация ловится SPA-роутером на /share.
        share_target: {
          action: '/lifehearth/share',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
        // Пункты по долгому нажатию на иконку (это WebKit поддерживает и на iOS).
        shortcuts: [
          { name: 'Быстрый захват', url: '/lifehearth/share' },
          { name: 'Новая заметка', url: '/lifehearth/notes/new' },
          { name: 'Новая задача', url: '/lifehearth/tasks' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: '/lifehearth/index.html',
        // skipWaiting+clientsClaim: новый SW не ждёт в waiting, а сразу
        // активируется и перехватывает открытую страницу → controllerchange →
        // авто-reload на свежую версию (иначе обновление откладывалось до
        // полного закрытия всех вкладок/иконки PWA — на iOS почти никогда).
        skipWaiting: true,
        clientsClaim: true,
        // Свой обработчик push/notificationclick поверх сгенерированного SW.
        importScripts: ['push-sw.js'],
      },
    }),
  ],
}))
