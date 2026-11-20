// Цикл tool use: модель просит инструмент → исполняем на устройстве → отдаём
// результат → повторяем, пока не придёт обычный текстовый ответ.
//
// Цикл живёт на клиенте: данные лежат в Dexie на устройстве, воркер — только
// прокси к провайдеру и ничего про инструменты не знает. Каждый раунд — это
// отдельный запрос со всей историей, поэтому usage суммируется по раундам:
// «сколько стоил ответ» должно включать и служебные круги.

import { requestChat, type AiChatMessage, type AiReply } from './aiClient';
import { TOOL_DEFS, runTool, noDataSystemPrompt, toolsSystemPrompt, type ToolTraceEntry } from './tools';
import { WRITE_TOOLS } from './actions';
import type { AiAction } from '../../db/types';

// Потолок кругов — страховка от зацикливания «прочитаю-ка ещё раз». Насыщение
// потолка — не ошибка: отдаём накопленный текст, а модель к этому моменту уже
// видела данные всех сделанных вызовов. С записью (20.11.2026) кругов нужно
// больше: «прочитай задачи → создай шаблон → создай задачу» у модели, которая
// не шлёт вызовы пачкой, — уже четыре круга с ответом.
const MAX_ROUNDS = 8;

/** Потолок изменений за ответ — решение Влада 20.11: подменённая инструкция в
 *  заметке не должна суметь переписать полприложения за один ответ. Считаются
 *  записи (тренировка из трёх видов — три), неудачный вызов — как одна. Сверх
 *  потолка вызов не исполняется, модель получает отказ текстом. */
export const MAX_WRITES = 20;

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
  /** Начало исполнения инструмента (машинное имя) — для строки «читаю…». */
  onTool?: (name: string) => void;
  /** Изменение данных — сразу по исполнении: обрыв посреди ответа не должен
   *  терять уже сделанное (иначе его не отменить с карточки). */
  onAction?: (action: AiAction) => void;
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
  let writes = 0;

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
      const name = call.function.name;
      params.onTool?.(name);
      const write = WRITE_TOOLS.has(name);
      const result: { text: string; count: number; actions?: AiAction[] } =
        write && writes >= MAX_WRITES
          ? { text: JSON.stringify({ error: `не больше ${MAX_WRITES} изменений за ответ — остальное в следующем сообщении` }), count: 0 }
          : await runTool(name, call.function.arguments);
      if (write) writes += Math.max(1, (result.actions ?? []).reduce((n, a) => n + a.ids.length, 0));
      for (const a of result.actions ?? []) params.onAction?.(a);
      // След — только чтение: что ушло провайдеру. Записанное видно карточкой.
      if (!write) trace.push({ tool: name, count: result.count });
      wire.push({ role: 'tool', tool_call_id: call.id, content: result.text });
    }
  }
  // Недостижимо: выход из цикла всегда через return выше.
  throw new Error('unreachable');
}
