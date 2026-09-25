// Цикл tool use: модель просит инструмент → исполняем на устройстве → отдаём
// результат → повторяем, пока не придёт обычный текстовый ответ.
//
// Цикл живёт на клиенте: данные лежат в Dexie на устройстве, воркер — только
// прокси к провайдеру и ничего про инструменты не знает. Каждый раунд — это
// отдельный запрос со всей историей, поэтому usage суммируется по раундам:
// «сколько стоил ответ» должно включать и служебные круги.

import { requestChat, type AiChatMessage, type AiReply } from './aiClient';
import { TOOL_DEFS, TOOL_LABELS, runTool, noDataSystemPrompt, toolsSystemPrompt, type ToolTraceEntry } from './tools';

// Потолок кругов — страховка от зацикливания «прочитаю-ка ещё раз». Насыщение
// потолка — не ошибка: отдаём накопленный текст, а модель к этому моменту уже
// видела данные всех сделанных вызовов.
const MAX_ROUNDS = 6;

export interface AgentReply extends AiReply {
  toolTrace: ToolTraceEntry[];
}

export async function runAgent(params: {
  messages: AiChatMessage[];
  systemPrompt?: string;
  model?: string;
  signal?: AbortSignal;
  /** false — инструменты выключены, работаем как обычный чат одним запросом. */
  dataTools: boolean;
  onDelta?: (text: string) => void;
  /** Начало исполнения инструмента — для строки «читаю…» в интерфейсе. */
  onTool?: (label: string) => void;
  /** Шов для юнитов: подменный транспорт вместо сети. */
  request?: typeof requestChat;
}): Promise<AgentReply> {
  const send = params.request ?? requestChat;
  const system = [params.systemPrompt?.trim(), params.dataTools ? toolsSystemPrompt() : noDataSystemPrompt()]
    .filter(Boolean)
    .join('\n\n');

  const wire: AiChatMessage[] = [...params.messages];
  const trace: ToolTraceEntry[] = [];
  const usage = { in: 0, out: 0 };
  const textParts: string[] = [];

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const reply = await send({
      messages: wire,
      systemPrompt: system,
      model: params.model,
      signal: params.signal,
      tools: params.dataTools ? TOOL_DEFS : undefined,
      onDelta: params.onDelta,
    });
    usage.in += reply.usage.in;
    usage.out += reply.usage.out;

    const calls = params.dataTools ? (reply.toolCalls ?? []) : [];
    if (!calls.length || round === MAX_ROUNDS) {
      if (reply.content.trim()) textParts.push(reply.content);
      return {
        content: textParts.join('\n\n'),
        model: reply.model,
        usage,
        finishReason: reply.finishReason,
        toolCalls: undefined,
        toolTrace: trace,
      };
    }

    // Текст перед вызовом («сейчас посмотрю…») сохраняем: он уже напечатан
    // стримом на экране, и финальная запись обязана его содержать.
    if (reply.content.trim()) textParts.push(reply.content);
    wire.push({ role: 'assistant', content: reply.content || null, tool_calls: calls });
    for (const call of calls) {
      if (params.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      params.onTool?.(TOOL_LABELS[call.function.name] ?? call.function.name);
      const result = await runTool(call.function.name, call.function.arguments);
      trace.push({ tool: call.function.name, count: result.count });
      wire.push({ role: 'tool', tool_call_id: call.id, content: result.text });
    }
  }
  // Недостижимо: выход из цикла всегда через return выше.
  throw new Error('unreachable');
}
