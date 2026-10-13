import { describe, expect, it } from 'vitest';
import type { FamilyConfig, FamilyMember } from '../../db/types';
import { partnerOf, previewWhen, splitChats } from './chats';

const cfg = (familyId: string) => ({ familyId, selfMemberId: `me-${familyId}` }) as FamilyConfig;
const mem = (familyId: string, id: string, extra: Partial<FamilyMember> = {}) =>
  ({ familyId, id, displayName: id, leftAt: null, ...extra }) as FamilyMember;

describe('список чатов', () => {
  it('первая группа и группы от трёх человек — общие, остальные — личные', () => {
    const configs = [cfg('wife'), cfg('fam'), cfg('mom'), cfg('waiting')];
    const members = [
      mem('wife', 'me-wife'), mem('wife', 'Жена'),
      mem('fam', 'me-fam'), mem('fam', 'Мама'), mem('fam', 'Папа'),
      mem('mom', 'me-mom'), mem('mom', 'Мама'),
      mem('waiting', 'me-waiting'),
    ];
    const { groups, pairs } = splitChats(configs, members);
    // Семья из двоих стоит первой — она общая, с задачами, а не «личка».
    expect(groups.map((c) => c.familyId)).toEqual(['wife', 'fam']);
    expect(pairs.map((c) => c.familyId)).toEqual(['mom', 'waiting']);
  });

  it('исключённые и ушедшие не держат группу общей и не становятся собеседником', () => {
    const configs = [cfg('fam'), cfg('pair')];
    const members = [
      mem('fam', 'me-fam'),
      mem('pair', 'me-pair'), mem('pair', 'Мама'), mem('pair', 'Чужой', { removedAt: '2026-10-01' }),
      mem('pair', 'Ушёл', { leftAt: '2026-10-02' }),
    ];
    const { pairs } = splitChats(configs, members);
    expect(pairs.map((c) => c.familyId)).toEqual(['pair']);
    expect(partnerOf(configs[1], members)?.id).toBe('Мама');
  });

  it('пока собеседник не вошёл, его нет', () => {
    expect(partnerOf(cfg('p'), [mem('p', 'me-p')])).toBeUndefined();
  });

  it('время в строке: сегодня — часы, вчера — подпись, раньше — дата', () => {
    const now = new Date(2026, 9, 14, 12, 0);
    expect(previewWhen(new Date(2026, 9, 14, 9, 5).toISOString(), now, 'ru', 'Вчера')).toBe('09:05');
    expect(previewWhen(new Date(2026, 9, 13, 23, 59).toISOString(), now, 'ru', 'Вчера')).toBe('Вчера');
    expect(previewWhen(new Date(2026, 9, 1).toISOString(), now, 'ru', 'Вчера')).toMatch(/^1 окт/);
  });
});
