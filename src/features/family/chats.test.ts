import { describe, expect, it } from 'vitest';
import type { FamilyConfig, FamilyMember } from '../../db/types';
import { awaitingPartner, partnerOf, previewWhen, splitChats } from './chats';

const cfg = (familyId: string, pair?: boolean) => ({ familyId, selfMemberId: `me-${familyId}`, ...(pair ? { pair } : {}) }) as FamilyConfig;
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

  it('заведённый как личный — личный и первым, пока в нём двое; третий делает его общим', () => {
    // Человек без групп позвал маму по QR: этот чат у него первый и
    // единственный — и всё равно «Личный», а не «Группа» с общими задачами.
    const members = [mem('mom', 'me-mom'), mem('mom', 'Мама')];
    expect(splitChats([cfg('mom', true)], members)).toEqual({ groups: [], pairs: [cfg('mom', true)] });
    // Ждём собеседника — тоже личный.
    expect(splitChats([cfg('wait', true)], [mem('wait', 'me-wait')]).pairs).toHaveLength(1);
    // Приглашение не одноразовое: вошёл третий — чат честно становится общим.
    const three = [...members, mem('mom', 'Папа')];
    expect(splitChats([cfg('mom', true)], three).groups).toHaveLength(1);
  });

  it('личный чат первым не отнимает у следующей семьи из двоих звание общей', () => {
    // Сначала позвал маму по QR, потом завёл «Семью» с женой: «Семья» —
    // первая из не личных, значит общая, с задачами, хоть в ней и двое.
    const members = [mem('mom', 'me-mom'), mem('mom', 'Мама'), mem('fam', 'me-fam'), mem('fam', 'Жена')];
    const { groups, pairs } = splitChats([cfg('mom', true), cfg('fam')], members);
    expect(groups.map((c) => c.familyId)).toEqual(['fam']);
    expect(pairs.map((c) => c.familyId)).toEqual(['mom']);
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

  it('«ждём» — только у того, кто звал одного человека, и пока никто, кроме него, не входил', () => {
    const mine = { ...cfg('p', true), ownerSecret: 's' } as FamilyConfig;
    expect(awaitingPartner(mine, [mem('p', 'me-p')])).toBe(true);
    // Вошедший по приглашению до прихода участников с сервера: звать некого.
    expect(awaitingPartner(cfg('p', true), [mem('p', 'me-p')])).toBe(false);
    // Собеседник был и вышел — это не «ждём».
    expect(awaitingPartner(mine, [mem('p', 'me-p'), mem('p', 'Мама', { leftAt: '2026-11-01' })])).toBe(false);
    // Новая обычная группа, где пока я один, — звали не одного человека.
    expect(awaitingPartner({ ...cfg('g'), ownerSecret: 's' } as FamilyConfig, [mem('g', 'me-g')])).toBe(false);
  });

  it('время в строке: сегодня — часы, вчера — подпись, раньше — дата', () => {
    const now = new Date(2026, 9, 14, 12, 0);
    expect(previewWhen(new Date(2026, 9, 14, 9, 5).toISOString(), now, 'ru', 'Вчера')).toBe('09:05');
    expect(previewWhen(new Date(2026, 9, 13, 23, 59).toISOString(), now, 'ru', 'Вчера')).toBe('Вчера');
    expect(previewWhen(new Date(2026, 9, 1).toISOString(), now, 'ru', 'Вчера')).toMatch(/^1 окт/);
  });
});
