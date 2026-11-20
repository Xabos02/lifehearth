// Инкрементальный парсер SSE-потока OpenAI chat completions.
//
// Worker отдаёт поток провайдера байт в байт (§4.2 плана), формат разбирает
// клиент. Парсер отделён от fetch и написан на «скармливай куски любого
// размера»: сетевые чанки рвут события где угодно — посреди строки, посреди
// UTF-8 символа (это решает TextDecoder со stream:true снаружи), между
// `data:` и телом. Всё состояние — в буфере строки.
//
// Понимает ровно то, что нужно чату:
//   data: {"choices":[{"delta":{"content":"..."},"finish_reason":null}],...}
//   data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}
//   data: [DONE]
// Остальные поля события игнорируются. Событий `event:`/`id:` у completions
// не бывает, но строки без `data:` на всякий случай просто пропускаются.

/** Вызов инструмента, собранный из дельт: id и name приходят первым чанком,
 *  arguments — JSON-строка, накапливаемая кусками произвольного размера. */
export interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamState {
  buffer: string;
  content: string;
  toolCalls: StreamToolCall[];
  finishReason: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  done: boolean;
  /** Ошибка, присланная провайдером ВНУТРИ потока (HTTP при этом 200).
   *  Так делает часть агрегаторов: без этого поля событие молча пропускалось,
   *  и человек видел «пустой ответ 0→0» вместо причины. */
  error: string | null;
  /** index провайдера → место в toolCalls. Не равенство: см. feedStream. */
  slots: Record<number, number>;
}

export function newStreamState(): StreamState {
  return {
    buffer: '',
    content: '',
    toolCalls: [],
    slots: {},
    finishReason: null,
    tokensIn: null,
    tokensOut: null,
    done: false,
    error: null,
  };
}

interface OpenAiChunk {
  choices?: {
    delta?: {
      content?: string | null;
      // Дельты вызовов: index сшивает куски одного вызова между событиями.
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  // Формат ошибки в теле события: {error: {message, code?}} либо {error: "строка"}.
  error?: { message?: string; code?: string | number } | string | null;
}

/** Скормить кусок потока. Возвращает текст, ДОБАВИВШИЙСЯ этим куском. */
export function feedStream(st: StreamState, chunk: string): string {
  st.buffer += chunk;
  let added = '';
  // Событие SSE заканчивается пустой строкой, но completions шлют по одному
  // `data:` на событие — разбор построчно проще и покрывает оба случая.
  for (;;) {
    const nl = st.buffer.indexOf('\n');
    if (nl < 0) break;
    const line = st.buffer.slice(0, nl).replace(/\r$/, '');
    st.buffer = st.buffer.slice(nl + 1);
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      st.done = true;
      continue;
    }
    let obj: OpenAiChunk;
    try {
      obj = JSON.parse(payload) as OpenAiChunk;
    } catch {
      // Обрезанное посередине событие в конец потока — не повод терять
      // накопленный текст; просто пропускаем неразобранную строку.
      continue;
    }
    if (obj.error) {
      st.error =
        typeof obj.error === 'string'
          ? obj.error
          : obj.error.message || `код ${String(obj.error.code ?? 'неизвестен')}`;
      continue;
    }
    const choice = obj.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) {
      st.content += delta;
      added += delta;
    }
    for (const tc of choice?.delta?.tool_calls ?? []) {
      // Вызов узнаём по index, но новый id под уже занятым index — это новый
      // вызов: Gemma на Workers AI шлёт параллельные вызовы под одним index
      // (живой тест 20.11.2026: два search_notes, оба index 1, разные id).
      // Без этого аргументы склеивались в «{…}{…}», и модель отвергала всю
      // историю разговора (8007 «arguments must be valid JSON»).
      const key = typeof tc.index === 'number' ? tc.index : 0;
      let at = st.slots[key];
      if (at === undefined || (tc.id && st.toolCalls[at].id && st.toolCalls[at].id !== tc.id)) {
        at = st.toolCalls.length;
        st.toolCalls.push({ id: '', name: '', arguments: '' });
        st.slots[key] = at;
      }
      const slot = st.toolCalls[at];
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (typeof tc.function?.arguments === 'string') slot.arguments += tc.function.arguments;
    }
    if (choice?.finish_reason) st.finishReason = choice.finish_reason;
    // usage приходит финальным чанком при stream_options.include_usage —
    // как правило, с пустым choices.
    if (obj.usage) {
      if (typeof obj.usage.prompt_tokens === 'number') st.tokensIn = obj.usage.prompt_tokens;
      if (typeof obj.usage.completion_tokens === 'number') st.tokensOut = obj.usage.completion_tokens;
    }
  }
  return added;
}
