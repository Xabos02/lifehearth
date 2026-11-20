import { describe, expect, it } from 'vitest';
import type { Note } from '../../db/types';
import { groupNotesByDate } from './noteGroups';

const note = (id: string, updatedAt: string): Note =>
  ({ id, updatedAt, createdAt: updatedAt, deletedAt: null, title: id, content: '', tags: [], pinned: false, folderId: null }) as Note;

// «Сейчас» — пятница, 20 ноября 2026, 15:00 по локальному времени.
const NOW = new Date(2026, 10, 20, 15, 0);
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

describe('groupNotesByDate', () => {
  it('раскладывает по сегодня / вчера / 7 / 30 дней / месяцам / годам в порядке ленты', () => {
    const notes = [
      note('today', at(2026, 10, 20, 9)),
      note('yesterday-late', at(2026, 10, 19, 23)),
      note('week', at(2026, 10, 15)),
      note('month', at(2026, 10, 1)),
      note('aug', at(2026, 7, 3)),
      note('aug2', at(2026, 7, 1)),
      note('old', at(2024, 2, 5)),
    ];
    const g = groupNotesByDate(notes, NOW);
    expect(g.map((x) => x.key)).toEqual(['today', 'yesterday', 'week', 'month', 'm7', 'y2024']);
    expect(g.map((x) => x.label)).toEqual(['Сегодня', 'Вчера', 'Последние 7 дней', 'Последние 30 дней', 'Август', '2024']);
    expect(g[4].notes.map((n) => n.id)).toEqual(['aug', 'aug2']);
  });

  it('граница — локальная полночь: 00:00 сегодня уже «Сегодня», 23:59 вчера — «Вчера»', () => {
    const g = groupNotesByDate(
      [note('a', new Date(2026, 10, 20, 0, 0).toISOString()), note('b', new Date(2026, 10, 19, 23, 59).toISOString())],
      NOW,
    );
    expect(g.map((x) => [x.key, x.notes.map((n) => n.id)])).toEqual([
      ['today', ['a']],
      ['yesterday', ['b']],
    ]);
  });

  it('битая дата и дата из будущего не прячутся в конец — идут в «Сегодня»', () => {
    const g = groupNotesByDate([note('bad', 'not-a-date'), note('future', at(2027, 0, 1))], NOW);
    expect(g).toHaveLength(1);
    expect(g[0].key).toBe('today');
  });

  it('пустой список — пустая лента', () => {
    expect(groupNotesByDate([], NOW)).toEqual([]);
  });
});
