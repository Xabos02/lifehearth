// Операции с чатами и сообщениями раздела ИИ.
//
// Запись идёт НАПРЯМУЮ в Dexie, минуя db/repo.ts. Причина: repo дёргает
// scheduleSyncSoon() после каждой записи, а llmChats/llmMessages в
// SYNCED_TABLES не входят — при активной переписке это давало бы полный скан
// всех синкаемых таблиц каждые 1.5 секунды впустую. Штампы BaseEntity
// проставляем здесь сами, поэтому записи остаются совместимыми с общей моделью
// и мягким удалением.

import { db } from '../../db/db';
import { now, uid, alive } from '../../db/repo';
import type { LlmChat, LlmMessage } from '../../db/types';
import { DEFAULT_MODEL, costRub } from './models';
import type { AiReply } from './aiClient';

/** Заголовок чата из первого вопроса — короткая первая строка без хвостов. */
export function autoTitle(text: string): string {
  const line = text.trim().split('\n')[0].trim();
  if (!line) return 'Без названия';
  return line.length > 48 ? `${line.slice(0, 48).trimEnd()}…` : line;
}

export async function listChats(): Promise<LlmChat[]> {
  const rows = alive(await db.llmChats.toArray());
  // Свежие сверху: чат без сообщений сортируем по времени создания.
  return rows.sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
}

export async function getChat(id: string): Promise<LlmChat | undefined> {
  const c = await db.llmChats.get(id);
  return c && !c.deletedAt ? c : undefined;
}

export async function createChat(model: string = DEFAULT_MODEL, dataTools = false): Promise<LlmChat> {
  const ts = now();
  const chat: LlmChat = {
    id: uid(),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    title: 'Новый чат',
    model,
    systemPrompt: '',
    lastMessageAt: null,
    dataTools,
  };
  await db.llmChats.add(chat);
  return chat;
}

export async function patchChat(id: string, changes: Partial<Omit<LlmChat, 'id' | 'createdAt'>>): Promise<void> {
  await db.llmChats.update(id, { ...changes, updatedAt: now() });
}

/** Мягкое удаление чата вместе со его сообщениями. */
export async function removeChat(id: string): Promise<void> {
  const ts = now();
  await db.llmChats.update(id, { deletedAt: ts, updatedAt: ts });
  const ids = (await db.llmMessages.where('chatId').equals(id).toArray()).map((m) => m.id);
  if (ids.length) await db.llmMessages.bulkUpdate(ids.map((k) => ({ key: k, changes: { deletedAt: ts, updatedAt: ts } })));
}

export async function chatMessages(chatId: string): Promise<LlmMessage[]> {
  const rows = alive(await db.llmMessages.where('chatId').equals(chatId).toArray());
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function addMessage(m: Omit<LlmMessage, keyof import('../../db/types').BaseEntity>): Promise<LlmMessage> {
  const ts = now();
  const row: LlmMessage = { ...m, id: uid(), createdAt: ts, updatedAt: ts, deletedAt: null };
  await db.llmMessages.add(row);
  await db.llmChats.update(m.chatId, {
    lastMessageAt: ts,
    updatedAt: ts,
    // Превью для списка чатов. Ошибка контента не несёт — берём её текст.
    lastMessageText: (m.content || m.error || '').slice(0, 90),
  });
  return row;
}

export async function addUserMessage(chat: LlmChat, content: string): Promise<LlmMessage> {
  // Первый вопрос заодно даёт чату имя — руками переименовывать не нужно.
  if (chat.title === 'Новый чат') await patchChat(chat.id, { title: autoTitle(content) });
  return addMessage({
    chatId: chat.id,
    role: 'user',
    content,
    model: null,
    tokensIn: null,
    tokensOut: null,
    costRub: null,
    status: 'done',
    error: null,
  });
}

export async function addAssistantMessage(
  chatId: string,
  reply: AiReply & { toolTrace?: { tool: string; count: number }[] },
): Promise<LlmMessage> {
  return addMessage({
    chatId,
    role: 'assistant',
    content: reply.content,
    model: reply.model,
    tokensIn: reply.usage.in,
    tokensOut: reply.usage.out,
    costRub: costRub(reply.model, reply.usage.in, reply.usage.out),
    status: 'done',
    error: null,
    finishReason: reply.finishReason ?? null,
    toolTrace: reply.toolTrace?.length ? reply.toolTrace : null,
  });
}

/** Ответ-заглушка с текстом ошибки: пузырь виден, повтор возможен. */
export async function addErrorMessage(chatId: string, error: string): Promise<LlmMessage> {
  return addMessage({
    chatId,
    role: 'assistant',
    content: '',
    model: null,
    tokensIn: null,
    tokensOut: null,
    costRub: null,
    status: 'error',
    error,
  });
}

/** Удалить одно сообщение (мягко) — нужно для повтора ответа. */
export async function removeMessage(id: string): Promise<void> {
  const ts = now();
  await db.llmMessages.update(id, { deletedAt: ts, updatedAt: ts });
}

/** Сколько последних сообщений уходит в модель. Каждый запрос несёт весь
 *  контекст заново, и без потолка длинный чат дорожает с каждой репликой —
 *  до бесконечности. 30 сообщений ≈ 15 обменов: за глаза для связности. */
const CONTEXT_LIMIT = 30;

/** Контекст для отправки в модель: только успешные непустые сообщения,
 *  не больше CONTEXT_LIMIT последних. */
export function toContext(messages: LlmMessage[]): { role: 'user' | 'assistant'; content: string }[] {
  return messages
    .filter((m) => m.status === 'done' && m.content.trim())
    .slice(-CONTEXT_LIMIT)
    .map((m) => ({ role: m.role, content: m.content }));
}

/** Экспорт диалога в markdown — единственная страховка, пока чат не синкается. */
export function exportChatMarkdown(chat: LlmChat, messages: LlmMessage[]): string {
  const head = `# ${chat.title}\n\n_${new Date(chat.createdAt).toLocaleString('ru-RU')}_\n`;
  const body = messages
    .map((m) => {
      if (m.status === 'error') return `**Ошибка:** ${m.error ?? ''}`;
      return m.role === 'user' ? `## Вопрос\n\n${m.content}` : `## Ответ\n\n${m.content}`;
    })
    .join('\n\n');
  return `${head}\n${body}\n`;
}
