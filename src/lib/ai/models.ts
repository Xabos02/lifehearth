// Реестр моделей и расчёт стоимости.
//
// Реестр — константа в коде, а не таблица в БД: одна запись на модель,
// меняется только при обновлении приложения, в синк и бэкап ей не место.
//
// С 1.69.0 ассистент бесплатный и без настроек (решение Влада 18.11.2026):
// две модели Cloudflare Workers AI через binding воркера. 10 000 Neurons в
// день на весь аккаунт, сброс в 00:00 UTC, сверх — отказ 3036, а не счёт (на
// плане Workers Free). Запросы не хранятся и не идут в обучение. Заглушка и
// платные Claude через Polza.ai из списка убраны.
//
// Цены — в РУБЛЯХ за миллион токенов. У бесплатных — ноль; поля оставлены,
// чтобы стоимость под ответом считалась тем же путём, если вернётся платная.

import { t } from '../i18n';

export interface ModelInfo {
  id: string;
  label: string;
  priceIn: number; // ₽ за 1M входных токенов
  priceOut: number; // ₽ за 1M выходных токенов
}

// Замер 16.11.2026 на 10 русских вопросах: Gemma — всё верно, ~31 Neuron на
// вопрос; Qwen (reasoning low) — умнее, ~190 Neurons. Настройки моделей —
// CF_MODELS в worker/src/index.js.
export const MODELS: ModelInfo[] = [
  { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4 (бесплатно)', priceIn: 0, priceOut: 0 },
  { id: '@cf/qwen/qwen3.8-27b', label: 'Qwen 3.8 (бесплатно)', priceIn: 0, priceOut: 0 },
];

export const DEFAULT_MODEL = MODELS[0].id;

/** Модель для запроса. В старых чатах лежат заглушка или Claude, которых в
 *  списке больше нет, — они отвечают моделью по умолчанию. */
export function effectiveModel(id: string | null | undefined): string {
  return id && modelById(id) ? id : DEFAULT_MODEL;
}

export function modelById(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

export function modelLabel(id: string | null): string {
  if (!id) return '';
  return t(modelById(id)?.label ?? id);
}

/** Стоимость запроса в рублях. null, если модель незнакомая (цену не выдумываем). */
export function costRub(modelId: string | null, tokensIn: number, tokensOut: number): number | null {
  const m = modelId ? modelById(modelId) : undefined;
  if (!m) return null;
  return (tokensIn * m.priceIn + tokensOut * m.priceOut) / 1_000_000;
}

/** «12,34 ₽» / «0,02 ₽» / «бесплатно» — короткая подпись под ответом. */
export function formatCost(rub: number | null): string {
  if (rub === null) return '';
  if (rub === 0) return t('бесплатно');
  if (rub < 0.01) return '<0,01 ₽';
  return `${rub.toFixed(2).replace('.', ',')} ₽`;
}
