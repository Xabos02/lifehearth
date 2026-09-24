import type { ExpenseItem, ExpenseRecurrence } from '../db/types';
import { getLang, t } from './i18n';

/** Множитель приведения суммы к одному месяцу. oneoff не входит в регулярную нагрузку. */
const MONTHLY_FACTOR: Record<ExpenseRecurrence, number> = {
  monthly: 1,
  weekly: 52 / 12, // ≈4.333 недели в месяце
  yearly: 1 / 12,
  oneoff: 0,
};

/** Ежемесячный эквивалент одной записи (0 для разовых). */
export function monthlyAmount(item: ExpenseItem): number {
  return item.amount * MONTHLY_FACTOR[item.recurrence];
}

export interface FinanceSummary {
  expense: number; // регулярные траты в месяц
  income: number; // регулярные доходы в месяц
  balance: number; // доход − расход
  byCategory: { category: string; amount: number }[]; // только траты, по убыванию
}

/** Сводка по активным записям: месячные траты/доходы, баланс, разбивка трат. */
export function financeSummary(items: ExpenseItem[]): FinanceSummary {
  const active = items.filter((i) => i.active);
  let expense = 0;
  let income = 0;
  const cats = new Map<string, number>();

  for (const item of active) {
    const m = monthlyAmount(item);
    if (item.kind === 'income') {
      income += m;
    } else {
      expense += m;
      // Разовая трата в месяц даёт 0 ₽ — строки в разбивке ей не положено:
      // иначе карточка показывала пустое «Прочее — 0 ₽» с нулевой полосой.
      if (m === 0) continue;
      const cat = item.category || t('Прочее');
      cats.set(cat, (cats.get(cat) ?? 0) + m);
    }
  }

  const byCategory = [...cats.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  return { expense, income, balance: income - expense, byCategory };
}

/** «12 500 ₽» — рубли без копеек; неразрывные пробелы и в разряде тысяч, и
 *  перед знаком валюты (сумма не разрывается переносом строки). */
export function formatRub(amount: number): string {
  const rounded = Math.round(amount);
  // Валюта данных — рубли, знак остаётся ₽ на любом языке; локаль только
  // группирует разряды (12 345 против 12,345).
  return `${rounded.toLocaleString(getLang() === 'ru' ? 'ru-RU' : 'en-US')}\u00A0₽`;
}

/** Та же сумма, но с обычными пробелами вместо неразрывных.
 *  formatRub склеивает разряды NBSP — строка становится монолитом и целиком
 *  задаёт min-content блока, поэтому в узкой колонке она не переносится, а
 *  вылезает за карточку и молча срезается .card{overflow:hidden} («1 200 35…»
 *  вместо «1 200 350 ₽» — читается как другое число). Перенос по границам
 *  разрядов выглядит хуже монолита, но никогда не врёт. Ставим только там, где
 *  сумма живёт в узком боксе; в широких строках перенос всё равно не сработает. */
export function wrapRub(amount: number): string {
  // \u00A0 и \u202F — оба варианта неразрывного пробела: ru-RU группирует разряды
  // первым, но узкий встречается в других сборках ICU. Экранированная запись
  // вместо самого символа: в исходнике он неотличим от обычного пробела.
  return formatRub(amount).replace(/[\u00A0\u202F]/g, ' ');
}

/** Число с русским разделителем тысяч: 150000 → «150 000» (дробные — через запятую). */
export function formatNum(n: number): string {
  return n.toLocaleString('ru-RU');
}

export interface UpcomingPayment {
  item: ExpenseItem;
  date: string; // 'YYYY-MM-DD' ближайшего списания
  daysLeft: number;
}

/**
 * Ближайшие ежемесячные списания (расходы с recurrence='monthly' и dayOfMonth)
 * в пределах daysAhead дней. Для напоминаний на «Сегодня».
 */
export function upcomingExpenses(
  items: ExpenseItem[],
  todayKey: string,
  daysAhead = 7,
): UpcomingPayment[] {
  const today = new Date(`${todayKey}T00:00:00`);
  const result: UpcomingPayment[] = [];

  for (const item of items) {
    if (!item.active || item.kind !== 'expense') continue;
    if (item.recurrence !== 'monthly' || !item.dayOfMonth) continue;

    // ближайшая дата с этим днём месяца: этот месяц или следующий
    for (let monthOffset = 0; monthOffset <= 1; monthOffset++) {
      const y = today.getFullYear();
      const m = today.getMonth() + monthOffset;
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const day = Math.min(item.dayOfMonth, daysInMonth);
      const d = new Date(y, m, day);
      const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
      if (diff >= 0 && diff <= daysAhead) {
        const pad = (n: number) => String(n).padStart(2, '0');
        result.push({
          item,
          date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
          daysLeft: diff,
        });
        break;
      }
    }
  }
  return result.sort((a, b) => a.daysLeft - b.daysLeft);
}

export const EXPENSE_CATEGORY_SUGGESTIONS = [
  'Жильё',
  'Еда',
  'Транспорт',
  'Подписки',
  'Здоровье',
  'Связь',
  'Развлечения',
  'Одежда',
  'Прочее',
];
