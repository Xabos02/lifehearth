// Лента заметок по времени — как в Apple Notes и Bear: «Сегодня», «Вчера»,
// «Последние 7 дней», «Последние 30 дней», дальше месяцы текущего года и годы.
// Чистая функция без React и Dexie: границы считаются от локальной полуночи,
// заметка в 23:59 остаётся во «вчера», а не съезжает в «сегодня».

import { format } from 'date-fns';
import type { Note } from '../../db/types';
import { dateLocale } from '../../lib/dates';
import { t } from '../../lib/i18n';

export interface NoteGroup {
  key: string;
  label: string;
  notes: Note[];
}

const DAY = 86_400_000;

/** Заметки уже отсортированы по updatedAt по убыванию — порядок групп и
 *  порядок внутри групп из него и берутся. */
export function groupNotesByDate(notes: Note[], now: Date = new Date()): NoteGroup[] {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups: NoteGroup[] = [];
  const byKey = new Map<string, NoteGroup>();
  for (const n of notes) {
    const d = new Date(n.updatedAt);
    const ts = d.getTime();
    let key: string;
    let label: string;
    if (Number.isNaN(ts) || ts >= midnight) {
      // Битая дата или «из будущего» (часы другого устройства) — в «Сегодня»:
      // спрятать заметку в конец ленты хуже, чем показать её первой.
      key = 'today';
      label = t('Сегодня');
    } else if (ts >= midnight - DAY) {
      key = 'yesterday';
      label = t('Вчера');
    } else if (ts >= midnight - 7 * DAY) {
      key = 'week';
      label = t('Последние 7 дней');
    } else if (ts >= midnight - 30 * DAY) {
      key = 'month';
      label = t('Последние 30 дней');
    } else if (d.getFullYear() === now.getFullYear()) {
      key = `m${d.getMonth()}`;
      const m = format(d, 'LLLL', { locale: dateLocale() });
      label = m.charAt(0).toUpperCase() + m.slice(1);
    } else {
      key = `y${d.getFullYear()}`;
      label = String(d.getFullYear());
    }
    let g = byKey.get(key);
    if (!g) {
      g = { key, label, notes: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.notes.push(n);
  }
  return groups;
}
