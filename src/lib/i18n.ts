// Локализация. Русский — ИСХОДНЫЙ язык: строки в коде остаются русскими и
// читабельными, словарь EN строится поверх них — t('Сохранить') → 'Save'.
// Непереведённая строка честно показывается по-русски, поэтому перевод
// приложения идёт постепенно, экран за экраном, ничего не ломая по дороге.
//
// Ключ словаря — сама русская строка. Никаких выдуманных идентификаторов
// (`tasks.sheet.save`): их пришлось бы придумывать для двух тысяч строк, а
// поиск по коду перестал бы находить текст с экрана.
//
// Подстановки — фигурными скобками: t('Файл больше {mb} МБ', { mb: 8 }).
// Шаблонная строка с ${} не годится ключом — она уникальна на каждый рендер.
//
// Смена языка перерисовывает всё приложение перезагрузкой (см. настройку):
// строки читаются в момент рендера, и reload — самый честный способ обновить
// каждую из них. Язык меняют раз в жизни, цена приемлема.

import { EN } from './i18n/en';
import { plural } from './plural';

export type Lang = 'ru' | 'en';
export type LangSetting = Lang | undefined; // undefined = как в системе

let current: Lang = 'ru';

/** Язык из настройки; отсутствие настройки — по языку системы. Существующие
 *  пользователи без поля language получают system → их телефоны русские. */
export function resolveLang(setting: LangSetting): Lang {
  if (setting === 'ru' || setting === 'en') return setting;
  return /^ru/i.test(navigator.language ?? 'ru') ? 'ru' : 'en';
}

/** Ставится один раз до первого рендера (main.tsx) и при смене настройки. */
export function setLang(l: Lang): void {
  current = l;
  // Юниты гоняются в Node без DOM — атрибут <html lang> ставим когда он есть.
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}

export function getLang(): Lang {
  return current;
}

/** Перевод строки интерфейса. Ключ — русская строка как есть. */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = current === 'ru' ? key : (EN[key] ?? key);
  if (vars) {
    // Замена — функцией: строковый второй аргумент replaceAll трактует
    // $$ / $& / $' / $` как спецпаттерны, и имя участника «Ba$$» в
    // подстановке исказилось бы. Функция вставляет значение дословно.
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, () => String(v));
  }
  return s;
}

/** Английские пары единственное/множественное — по ключу русской формы
 *  «много» (третьей): она в наборе самая узнаваемая («дней», «задач»). */
const EN_PLURALS: Record<string, [string, string]> = {
  дней: ['day', 'days'],
  тренировок: ['workout', 'workouts'],
  задач: ['task', 'tasks'],
  заметок: ['note', 'notes'],
  привычек: ['habit', 'habits'],
  минут: ['minute', 'minutes'],
  часов: ['hour', 'hours'],
  недель: ['week', 'weeks'],
  месяцев: ['month', 'months'],
  лет: ['year', 'years'],
  циклов: ['cycle', 'cycles'],
  менструаций: ['period', 'periods'],
  'завершённых циклов': ['completed cycle', 'completed cycles'],
  'активных целей': ['active goal', 'active goals'],
  отметок: ['entry', 'entries'],
  файлов: ['file', 'files'],
  участников: ['member', 'members'],
  фото: ['photo', 'photos'],
  пунктов: ['item', 'items'],
};

/** Склонение с учётом языка: русские формы — как в plural(), английская пара
 *  берётся из EN_PLURALS по третьей форме. Нет пары в словаре — русский
 *  fallback, как у t(). */
export function tPlural(n: number, forms: readonly [string, string, string]): string {
  if (current === 'ru') return plural(n, forms);
  const en = EN_PLURALS[forms[2]];
  if (!en) return plural(n, forms);
  return Math.abs(n) === 1 ? en[0] : en[1];
}

/** Число и слово вместе: tPlur(5, ['задача','задачи','задач']) → '5 tasks'. */
export function tPlur(n: number, forms: readonly [string, string, string]): string {
  return `${n} ${tPlural(n, forms)}`;
}
