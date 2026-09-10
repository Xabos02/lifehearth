import { db } from '../../db/db';
import { alive, create, update } from '../../db/repo';
import type { LearningItem } from '../../db/types';
import { todayKey } from '../../lib/dates';

/** Записать занятие: сколько минут человек сегодня сидел над материалом.
 *
 *  Занятия за один день СКЛАДЫВАЮТСЯ, а не заменяют друг друга: сел утром на
 *  час, вечером добавил ещё два — за день три, а не два. Заменяющая запись
 *  тихо съедала бы половину работы, и заметить это можно было бы только по
 *  осевшему темпу через неделю. */
export async function logSession(
  item: LearningItem,
  minutes: number,
  note = '',
  date = todayKey(),
): Promise<void> {
  if (!Number.isFinite(minutes) || minutes <= 0) return;
  const sameDay = alive(await db.learningLogs.where('itemId').equals(item.id).toArray()).find(
    (l) => l.date === date,
  );
  if (sameDay) {
    await update(db.learningLogs, sameDay.id, {
      minutes: (sameDay.minutes ?? 0) + minutes,
      // Пустую заметку не затираем: у первой записи дня она может быть
      // единственной осмысленной.
      note: note.trim() || sameDay.note,
    });
    return;
  }
  await create(db.learningLogs, {
    itemId: item.id,
    date,
    // Лог хранит абсолютный прогресс на эту дату — берём текущий, потому что
    // запись времени сама по себе прогресс не двигает.
    value: item.progressCurrent,
    minutes,
    note: note.trim(),
  });
}
