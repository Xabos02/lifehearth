import { callManager } from './family/familyCall';

// Перезагрузка на новую версию — только когда она никого не перебьёт.
//
// Новый service worker ставится сам (skipWaiting + clientsClaim), и страница
// перезагружается на свежую версию. Обновление проверяется при запуске и при
// каждом возврате в приложение, так что перезагрузка приходит через секунды
// после открытия — ровно когда человек начинает печатать. Раньше она ждала
// только конца звонка: у заметки пропадало всё набранное с последней паузы, а
// у только что начатой — вся заметка (аудит 18.11.2026, N6).
//
// Теперь перезагрузка ждёт:
//  · конца звонка — посреди разговора она рвёт соединение без единого сигнала
//    собеседнику;
//  · ухода фокуса из поля ввода или ухода приложения в фон — тогда человек её
//    и не заметит;
//  · сохранения. Экран с несохранённым вводом регистрирует здесь «сохрани
//    сейчас», и перезагрузка его дожидается. Сохранять на pagehide мало:
//    запись в IndexedDB, начатая уходящей страницей, обрывается вместе с ней;
//  · конца ответа ассистента (holdReload). Ответ печатается до минуты, и
//    перезагрузка посреди него теряла ответ молча: в чате оставался вопрос без
//    ответа и без «Повторить» (живой тест 20.11.2026 — выкатка 1.87.0 пришла
//    через 15 с после вопроса). В фоне держим тоже: человек часто сворачивает
//    приложение, пока модель думает.
//
// Вечно ждать набор нельзя: новый service worker уже управляет страницей и
// чистит кэш старой версии, и её ленивые куски могут перестать грузиться.
// Поэтому у отсрочки потолок, а сохранение перед перезагрузкой — в любом случае.

export const MAX_DEFER_MS = 3 * 60_000;
// Пауза после ухода фокуса. Мышью фокус уходит уже на нажатии кнопки
// «Сохранить» в шторке, раньше её click, — без паузы перезагрузка обгоняла
// сохранение формы, которая своё «сохрани сейчас» не регистрирует.
export const AFTER_FOCUS_MS = 1500;
const SAVE_WAIT_MS = 2000;
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

const savers = new Set<() => unknown>();

/** Зарегистрировать «сохрани сейчас», которого дождётся перезагрузка. Возвращает отписку. */
export function saveBeforeReload(save: () => unknown): () => void {
  savers.add(save);
  return () => {
    savers.delete(save);
  };
}

export const inCall = () => callManager.getSnapshot().status !== 'idle';

const holds = new Set<symbol>();
const holdListeners = new Set<() => void>();

/** Придержать перезагрузку, пока идёт работа, которую она оборвёт (ответ
 *  ассистента). Возвращает «отпустить»; отпущенная — перезагрузка, если она
 *  ждала, идёт сразу. Потолок MAX_DEFER_MS действует и здесь. */
export function holdReload(): () => void {
  const key = Symbol('hold');
  holds.add(key);
  return () => {
    if (!holds.delete(key)) return;
    for (const listener of holdListeners) listener();
  };
}

/** Фокус в поле, куда печатают. Без instanceof: так проверка работает и в тесте без DOM. */
function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_INPUTS.has((el as HTMLInputElement).type);
}

async function saveAll(): Promise<void> {
  const all = Promise.allSettled([...savers].map((save) => Promise.resolve().then(save)));
  await Promise.race([all, new Promise((done) => setTimeout(done, SAVE_WAIT_MS))]);
}

let pending = false;

export function reloadWhenIdle(): void {
  if (pending) return;
  pending = true;
  const since = Date.now();
  let going = false;
  const stops: (() => void)[] = [];
  const check = () => {
    if (going || inCall()) return;
    const early = Date.now() - since < MAX_DEFER_MS;
    if (holds.size && early) return;
    const away = document.visibilityState === 'hidden';
    if (!away && typing() && early) return;
    going = true;
    for (const stop of stops) stop();
    void saveAll().then(() => window.location.reload());
  };
  const onFocusOut = () => setTimeout(check, AFTER_FOCUS_MS);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('visibilitychange', check);
  const cap = setTimeout(check, MAX_DEFER_MS);
  holdListeners.add(check);
  stops.push(
    callManager.subscribe(check),
    () => holdListeners.delete(check),
    () => document.removeEventListener('focusout', onFocusOut),
    () => document.removeEventListener('visibilitychange', check),
    () => clearTimeout(cap),
  );
  check();
}
