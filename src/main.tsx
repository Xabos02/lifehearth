import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { db, ensureSettings } from './db/db'
import { resolveLang, setLang } from './lib/i18n'
import { setConsentFlag, watchConsent } from './lib/consent'
import { ensurePersistentStorage } from './lib/storage'
import { StartupError } from './components/StartupError'

// Данные живут только локально — просим браузер не вычищать хранилище.
// Результат читает экран настроек: отказ означает, что Safari сотрёт всё
// после недели без визитов, и человек должен об этом узнать заранее.
void ensurePersistentStorage()

// Язык обязан встать ДО первого рендера: строки читаются в момент рендера,
// и «мигание» русского перед английским — это дефект, а не мелочь. Чтение
// настройки из IndexedDB — миллисекунды.
void (async () => {
  const root = createRoot(document.getElementById('root')!)
  try {
    await ensureSettings()
    const s = await db.settings.get('app')
    setLang(resolveLang(s?.language))
    // Согласие на внешнее — тоже до первого рендера: раннеры синка и семьи,
    // «Фокус» и погода решают, идти ли в сеть, на первом же кадре.
    setConsentFlag(Boolean(s?.consentAt))
    void watchConsent()
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  } catch (e) {
    // Без этого человек видел пустой белый экран: весь рендер стоял за
    // открытием базы, а обработчика у промиса не было вовсе. Откат версии,
    // переполнение хранилища, повреждённая база на iOS — и приложение
    // выглядело сломанным навсегда, без слова о причине и без единой кнопки.
    setLang(resolveLang(undefined))
    root.render(<StartupError error={e} />)
  }
})()
