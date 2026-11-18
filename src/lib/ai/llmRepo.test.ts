// Механика чатов: потолок контекста и превью списка. Оба свойства — про
// деньги и удобство: без потолка длинный чат дорожает бесконечно, без
// превью список чатов — одинаковые заголовки без памяти о содержимом.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LlmMessage } from '../../db/types';

const { db } = await import('../../db/db');
const { addUserMessage, addAssistantMessage, createChat, toContext } = await import('./llmRepo');

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const msg = (i: number): LlmMessage => ({
  id: `m${i}`,
  chatId: 'c',
  createdAt: `2026-08-01T00:00:${String(i).padStart(2, '0')}.000Z`,
  updatedAt: '2026-08-01T00:00:00.000Z',
  deletedAt: null,
  role: i % 2 ? 'assistant' : 'user',
  content: `сообщение ${i}`,
  model: null,
  tokensIn: null,
  tokensOut: null,
  costRub: null,
  status: 'done',
  error: null,
});

describe('toContext', () => {
  it('режет историю до последних 30 сообщений — старт длинного чата не едет в модель', () => {
    const history = Array.from({ length: 40 }, (_, i) => msg(i));
    const ctx = toContext(history);
    expect(ctx).toHaveLength(30);
    expect(ctx[0].content).toBe('сообщение 10');
    expect(ctx[29].content).toBe('сообщение 39');
  });

  it('ошибки и пустые сообщения не входят в контекст', () => {
    const history = [msg(0), { ...msg(1), status: 'error' as const }, { ...msg(2), content: '  ' }];
    expect(toContext(history)).toHaveLength(1);
  });
});

describe('превью списка чатов', () => {
  it('последнее сообщение оседает на чате первыми словами', async () => {
    const chat = await createChat();
    await addUserMessage(chat, 'Разбери мои расходы за месяц, пожалуйста');
    await addAssistantMessage(chat.id, {
      content: 'Смотрю финансы: аренда съедает больше всего.',
      model: 'test',
      usage: { in: 1, out: 2 },
    });
    const row = await db.llmChats.get(chat.id);
    expect(row?.lastMessageText).toBe('Смотрю финансы: аренда съедает больше всего.');
  });
});

describe('createChat', () => {
  it('наследует переданную модель — новый чат не откатывается к модели по умолчанию', async () => {
    const c = await createChat('@cf/qwen/qwen3.8-27b');
    expect(c.model).toBe('@cf/qwen/qwen3.8-27b');
    const fallback = await createChat(undefined);
    expect(fallback.model).toBe('@cf/google/gemma-4-26b-a4b-it');
  });
});
