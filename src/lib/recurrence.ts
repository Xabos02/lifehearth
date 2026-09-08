import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  getDaysInMonth,
  getISODay,
  max,
  setDate,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import type { Recurrence } from '../db/types';
import { fromKey, toKey, WEEKDAY_LABELS } from './dates';
import { getLang, t } from './i18n';
import { plural } from './plural';

/**
 * Следующая дата повторяющейся задачи после её выполнения.
 * Результат не раньше, чем «после сегодня» (просроченная задача не плодит
 * хвост прошлых повторений), но фаза цикла всегда привязана к исходному
 * сроку (anchor) — иначе при interval>1 просрочка сбивала бы кадэнс.
 */
export function nextOccurrence(rec: Recurrence, dueKey: string | null): string {
  const today = startOfDay(new Date());
  const after = dueKey ? max([fromKey(dueKey), today]) : today;
  const anchor = dueKey ? fromKey(dueKey) : today;

  switch (rec.type) {
    case 'daily': {
      const step = Math.max(1, rec.interval);
      let d = addDays(anchor, step);
      while (d <= after) d = addDays(d, step);
      return toKey(d);
    }

    case 'weekly': {
      const step = Math.max(1, rec.interval);
      const days = [...rec.weekdays].sort((a, b) => a - b);
      if (days.length === 0) {
        let d = addWeeks(anchor, step);
        while (d <= after) d = addWeeks(d, step);
        return toKey(d);
      }
      // Идём по неделям кадэнса (anchor + k·interval) и берём первый
      // выбранный день недели строго после `after`.
      let weekStart = startOfWeek(anchor, { weekStartsOn: 1 });
      for (let i = 0; i < 520; i++) {
        for (const d of days) {
          const cand = addDays(weekStart, d - 1);
          if (cand > after) return toKey(cand);
        }
        weekStart = addWeeks(weekStart, step);
      }
      return toKey(addDays(weekStart, days[0] - 1));
    }

    case 'monthly': {
      const step = Math.max(1, rec.interval);
      const clampDay = (m: Date) => Math.min(rec.dayOfMonth, getDaysInMonth(m));
      let m = startOfMonth(anchor);
      for (let i = 0; i < 600; i++) {
        const cand = setDate(m, clampDay(m));
        if (cand > after) return toKey(cand);
        m = addMonths(m, step);
      }
      return toKey(setDate(m, clampDay(m)));
    }

    case 'yearly': {
      // Год от исходной даты; 29 февраля date-fns сам прижимает к 28-му.
      const step = Math.max(1, rec.interval);
      let d = addYears(anchor, step);
      while (d <= after) d = addYears(d, step);
      return toKey(d);
    }
  }
}

/** Краткое описание для UI: «Каждый день», «По Пн, Ср», «5-го числа».
 *  Русские конструкции согласуют род («Каждый/Каждые») — словарным ключом их
 *  не выразить, поэтому английская фраза строится своей веткой по getLang(). */
export function describeRecurrence(rec: Recurrence): string {
  const en = getLang() === 'en';
  switch (rec.type) {
    case 'daily':
      if (rec.interval === 1) return t('Каждый день');
      if (en) return `Every ${rec.interval} days`;
      return `${plural(rec.interval, ['Каждый', 'Каждые', 'Каждые'])} ${rec.interval} ${plural(rec.interval, ['день', 'дня', 'дней'])}`;
    case 'weekly': {
      // Фраза собирается ЦЕЛИКОМ в каждой ветке, а не приклеиванием префикса к
      // готовой самостоятельной фразе. Приклеивание давало «Каждые 2 недели По
      // Пн, Ср» — заглавная буква посреди предложения, — а без выбранных дней
      // и вовсе «Каждые 2 недели Еженедельно»: прямое самопротиворечие. Видно
      // это под каждой повторяющейся задачей и в обоих языках.
      const days = [...rec.weekdays].sort((a, b) => a - b).map((d) => t(WEEKDAY_LABELS[d - 1]));
      const list = days.join(', ');
      if (rec.interval === 1) return days.length ? t('По {days}', { days: list }) : t('Еженедельно');
      if (en) {
        return days.length
          ? `Every ${rec.interval} weeks on ${list}`
          : `Every ${rec.interval} weeks`;
      }
      // Русский — исходный язык, словарь ему не нужен; зато нужно склонение,
      // которого литеральный ключ словаря не выражает.
      const every = plural(rec.interval, ['Каждую', 'Каждые', 'Каждые']);
      const weeks = plural(rec.interval, ['неделю', 'недели', 'недель']);
      return days.length
        ? `${every} ${rec.interval} ${weeks} по ${list}`
        : `${every} ${rec.interval} ${weeks}`;
    }
    case 'monthly':
      return rec.interval === 1
        ? t('{d}-го числа', { d: rec.dayOfMonth })
        : t('{d}-го числа, раз в {n} мес.', { d: rec.dayOfMonth, n: rec.interval });
    case 'yearly':
      if (rec.interval === 1) return t('Каждый год');
      if (en) return `Every ${rec.interval} years`;
      return `${plural(rec.interval, ['Каждый', 'Каждые', 'Каждые'])} ${rec.interval} ${plural(rec.interval, ['год', 'года', 'лет'])}`;
  }
}

/** Дата начала ISO-дня недели в getISODay-семантике, реэкспорт для удобства фич. */
export { getISODay };
