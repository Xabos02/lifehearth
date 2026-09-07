import { describe, expect, it } from 'vitest';
import { ALLDAY_REMIND_TIME, reminderFireAt, type ReminderTask } from './push';

// Когда именно сработает напоминание.
//
// Раньше напоминание требовало у задачи ВРЕМЯ: без часа считать было не от
// чего, и поле в форме просто не показывалось. А срок «на день» — самый частый
// способ его поставить: «завтра сдать отчёт» пишут без часа, и напоминание там
// нужнее всего. Теперь у такой задачи точка отсчёта — утро.
//
// Место тихое: ошибка здесь не видна глазом и всплывает уведомлением не в тот
// день, поэтому арифметика проверяется прямо, а не через интерфейс.

const task = (extra: Partial<ReminderTask>): ReminderTask => ({
  id: 't1',
  title: 'Сдать отчёт',
  dueDate: '2026-09-10',
  dueTime: null,
  remindBefore: null,
  ...extra,
});

/** Локальное время в epoch ms — так же, как его считает приложение. */
const at = (iso: string) => new Date(iso).getTime();

describe('время срабатывания напоминания', () => {
  it('без срока напоминания нет', () => {
    expect(reminderFireAt(task({ dueDate: null, remindBefore: 0 }))).toBeNull();
  });

  it('без выбранного напоминания — нет', () => {
    expect(reminderFireAt(task({ dueTime: '14:15', remindBefore: null }))).toBeNull();
  });

  it('со временем: «вовремя» — ровно в час задачи', () => {
    expect(reminderFireAt(task({ dueTime: '14:15', remindBefore: 0 }))).toBe(
      at('2026-09-10T14:15:00'),
    );
  });

  it('со временем: «за 15 минут» — за пятнадцать минут до часа', () => {
    expect(reminderFireAt(task({ dueTime: '14:15', remindBefore: 15 }))).toBe(
      at('2026-09-10T14:00:00'),
    );
  });

  it('без времени: «в день задачи» — утром этого дня', () => {
    expect(reminderFireAt(task({ remindBefore: 0 }))).toBe(
      at(`2026-09-10T${ALLDAY_REMIND_TIME}:00`),
    );
  });

  it('без времени: «за день» — утром накануне, а не в полночь', () => {
    // Полночь — худший вариант из возможных: уведомление приходит, когда
    // человек спит, и к утру он его уже смахнул вместе с остальными.
    expect(reminderFireAt(task({ remindBefore: 1440 }))).toBe(
      at(`2026-09-09T${ALLDAY_REMIND_TIME}:00`),
    );
  });

  it('без времени: «за неделю» — утром за семь дней', () => {
    expect(reminderFireAt(task({ remindBefore: 10080 }))).toBe(
      at(`2026-09-03T${ALLDAY_REMIND_TIME}:00`),
    );
  });

  it('переход через месяц считается календарём, а не вычитанием дней из числа', () => {
    expect(reminderFireAt(task({ dueDate: '2026-10-02', remindBefore: 4320 }))).toBe(
      at(`2026-09-29T${ALLDAY_REMIND_TIME}:00`),
    );
  });

  it('битая дата не даёт напоминания вместо NaN-времени', () => {
    expect(reminderFireAt(task({ dueDate: 'не дата', remindBefore: 0 }))).toBeNull();
  });
});
