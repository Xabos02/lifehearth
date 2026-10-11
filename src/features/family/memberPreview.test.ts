import { describe, expect, it } from 'vitest';
import type { FamilyMessage } from '../../db/types';
import { previewByMember, previewWhen } from './memberPreview';

const msg = (p: Partial<FamilyMessage>): FamilyMessage => ({
  clientMsgId: Math.random().toString(36),
  familyId: 'f',
  seq: 1,
  senderMemberId: 'mom',
  createdAt: '2026-10-11T10:00:00.000Z',
  text: 'привет',
  status: 'acked',
  deletedAt: null,
  ...p,
});

describe('previewByMember', () => {
  it('берёт последнее видимое сообщение и считает непрочитанные только чужие после отметки', () => {
    const map = previewByMember(
      [
        msg({ seq: 5, text: 'старое', createdAt: '2026-10-11T09:00:00.000Z' }),
        msg({ seq: 6, text: 'новое', createdAt: '2026-10-11T09:30:00.000Z' }),
        msg({ seq: 7, reaction: { targetId: 'x', emoji: '❤️' }, createdAt: '2026-10-11T09:40:00.000Z' }),
        msg({ seq: 8, system: true, createdAt: '2026-10-11T09:50:00.000Z' }),
        msg({ seq: 9, senderMemberId: 'me', text: 'моё' }),
      ],
      'me',
      5,
    );
    expect(map.get('mom')?.last.text).toBe('новое');
    expect(map.get('mom')?.unread).toBe(1);
    expect(map.get('me')?.unread).toBe(0);
  });
});

describe('previewWhen', () => {
  const now = new Date(2026, 9, 11, 18, 0);
  it('сегодня — часы, вчера — подпись, раньше — дата', () => {
    expect(previewWhen(new Date(2026, 9, 11, 9, 5).toISOString(), now, 'ru-RU', 'вчера')).toBe('09:05');
    expect(previewWhen(new Date(2026, 9, 10, 23, 0).toISOString(), now, 'ru-RU', 'вчера')).toBe('вчера');
    expect(previewWhen(new Date(2026, 9, 1, 12, 0).toISOString(), now, 'ru-RU', 'вчера')).toMatch(/1/);
  });
});
