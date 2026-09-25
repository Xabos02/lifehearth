// Цикл tool use: связка «вызов → исполнение → follow-up → финальный текст».
//
// Транспорт подменяется через шов request — сюда сеть не ходит. Инструменты
// исполняются настоящие, поверх fake-indexeddb: цикл и чтение данных
// проверяются вместе, как поедут в проде.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiChatMessage, AiReply } from './aiClient';

const { db } = await import('../../db/db');
const { runAgent } = await import('./agentLoop');

const base = { createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', deletedAt: null };

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await db.tasks.bulkAdd([
    {
      ...base,
      id: 't1',
      title: 'Позвонить брату',
      notes: '',
      projectId: null,
      goalId: null,
      priority: 0,
      dueDate: null,
      dueTime: null,
      duration: null,
      remindBefore: null,
      completedAt: null,
      checklist: [],
      recurrence: null,
      tags: [],
      sortOrder: 1000,
    },
    {
      ...base,
      id: 't2',
      title: 'Сдать отчёт',
      notes: '',
      projectId: null,
      goalId: null,
      priority: 3,
      dueDate: '2026-08-20',
      dueTime: null,
      duration: null,
      remindBefore: null,
      completedAt: null,
      checklist: [],
      recurrence: null,
      tags: ['работа'],
      sortOrder: 2000,
    },
  ] as never[]);
});

function textReply(content: string): AiReply {
  return { content, model: 'test', usage: { in: 100, out: 20 }, finishReason: 'stop' };
}

function toolReply(name: string, args: string): AiReply {
  return {
    content: '',
    model: 'test',
    usage: { in: 50, out: 10 },
    finishReason: 'tool_calls',
    toolCalls: [{ id: 'call_1', type: 'function', function: { name, arguments: args } }],
  };
}

describe('runAgent', () => {
  it('вызов → данные → финал: follow-up несёт результат, usage суммируется', async () => {
    const seen: AiChatMessage[][] = [];
    const request = vi.fn(async (p: { messages: AiChatMessage[] }) => {
      seen.push(p.messages);
      return seen.length === 1 ? toolReply('list_tasks', '{}') : textReply('У тебя 2 задачи.');
    });

    const onTool = vi.fn();
    const reply = await runAgent({
      messages: [{ role: 'user', content: 'что у меня по задачам?' }],
      dataTools: true,
      request: request as never,
      onTool,
    });

    expect(reply.content).toBe('У тебя 2 задачи.');
    expect(reply.usage).toEqual({ in: 150, out: 30 });
    expect(reply.toolTrace).toEqual([{ tool: 'list_tasks', count: 2 }]);
    expect(onTool).toHaveBeenCalledWith('Задачи');

    // Второй запрос обязан нести и ответ-с-вызовом, и результат инструмента.
    const follow = seen[1];
    expect(follow[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1' }] });
    const toolMsg = follow[2] as { role: string; tool_call_id: string; content: string };
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('call_1');
    const payload = JSON.parse(toolMsg.content) as { tasks: { title: string }[] };
    expect(payload.tasks.map((t) => t.title)).toEqual(['Сдать отчёт', 'Позвонить брату']);
  });

  it('dataTools=false — один запрос без tools, даже если модель просит вызов', async () => {
    const request = vi.fn(async (p: { tools?: unknown[]; systemPrompt?: string }) => {
      expect(p.tools).toBeUndefined();
      // Модель знает, что данных нет и где их включить, — а не отвечает
      // «не вижу» без объяснения и не выдаёт прошлые ответы за сегодняшние.
      expect(p.systemPrompt).toContain('включить «Данные» под полем ввода');
      return textReply('обычный ответ');
    });
    const reply = await runAgent({
      messages: [{ role: 'user', content: 'привет' }],
      dataTools: false,
      request: request as never,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(reply.content).toBe('обычный ответ');
    expect(reply.toolTrace).toEqual([]);
  });

  it('потолок раундов: бесконечно просящая инструменты модель не зацикливает', async () => {
    const request = vi.fn(async () => toolReply('list_goals', '{}'));
    const reply = await runAgent({
      messages: [{ role: 'user', content: 'зациклись' }],
      dataTools: true,
      request: request as never,
    });
    // MAX_ROUNDS + финальный принудительный: запросов конечное число.
    expect(request.mock.calls.length).toBe(7);
    expect(reply.toolTrace.length).toBe(6);
  });

  it('текст перед вызовом не теряется в финальной записи', async () => {
    let n = 0;
    const request = vi.fn(async () => {
      n++;
      if (n === 1) {
        return {
          ...toolReply('list_tasks', '{}'),
          content: 'Сейчас посмотрю.',
        };
      }
      return textReply('Готово: 2 задачи.');
    });
    const reply = await runAgent({
      messages: [{ role: 'user', content: 'глянь задачи' }],
      dataTools: true,
      request: request as never,
    });
    expect(reply.content).toBe('Сейчас посмотрю.\n\nГотово: 2 задачи.');
  });
});
