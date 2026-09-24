/**
 * Русское склонение слова по числу — три формы: [для 1, для 2–4, для 5–20 и 0].
 * Учитывает исключение 11–14 («11 задач», не «11 задача»).
 *
 *   plural(1, ['день', 'дня', 'дней'])  → 'день'
 *   plural(2, ['день', 'дня', 'дней'])  → 'дня'
 *   plural(5, ['день', 'дня', 'дней'])  → 'дней'
 *   plural(21, ['день', 'дня', 'дней']) → 'день'
 */
export function plural(n: number, forms: readonly [string, string, string]): string {
  // Дробное — всегда вторая форма: «2,5 урока», «1,5 дня». По последней цифре
  // выходило «8,4 уроков» и «1,5 дней».
  if (!Number.isInteger(n)) return forms[1];
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}

/** Число и просклонённое слово вместе: plur(5, ['задача','задачи','задач']) → '5 задач'. */
export function plur(n: number, forms: readonly [string, string, string]): string {
  return `${n} ${plural(n, forms)}`;
}
