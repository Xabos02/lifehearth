// Клиент к своему AI-прокси на Cloudflare Worker.
//
// Ключ провайдера живёт в секретах воркера и на устройство не попадает: рядом
// в IndexedDB лежат ключи синхронизации и семьи, и лишняя поверхность там не
// нужна. Авторизация — тем же аккаунтом, что и синхронизация (X-Account +
// Bearer), поэтому раздел ИИ требует включённого синка.

import { WORKER_URL } from '../sync';
import { t } from '../i18n';
import { feedStream, newStreamState } from './openaiStream';
import { getSyncConfig } from '../syncState';
import { hasConsent } from '../consent';

export interface AiUsage {
  in: number;
  out: number;
}

export interface AiReply {
  content: string;
  model: string;
  usage: AiUsage;
  // Причина остановки провайдера: 'length' — упёрлись в max_tokens (ответ
  // обрезан), 'content_filter' — модель отклонила запрос. У заглушки её нет.
  finishReason?: string | null;
  // Запрошенные моделью вызовы инструментов (finish_reason === 'tool_calls').
  // Исполняет их цикл в agentLoop.ts — клиентский, у воркера данных нет.
  toolCalls?: WireToolCall[];
}

/** Вызов инструмента в wire-формате OpenAI (arguments — JSON-строкой). */
export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Сообщение в формате провода. Ответ-с-вызовами и результат инструмента —
 *  полноправные участники истории запроса: без них модель не свяжет свой
 *  вызов с данными и попросит их заново по кругу. */
export type WireMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type AiChatMessage = WireMessage;

export type AiErrorCode =
  | 'no_consent' // нет согласия на внешнее (задача 34) — сеть не трогаем
  | 'no_account' // синхронизация не настроена — нечем авторизоваться
  | 'unauthorized' // воркер не признал аккаунт
  | 'forbidden' // аккаунт не в списке разрешённых
  | 'bad_request'
  | 'rate_limit'
  | 'provider' // ошибка на стороне провайдера
  | 'network'
  | 'aborted';

export class AiError extends Error {
  // Поле объявлено явно, а не через parameter property: в проекте включён
  // erasableSyntaxOnly, и сокращённая форма конструктора там запрещена.
  code: AiErrorCode;
  constructor(code: AiErrorCode, message: string) {
    super(message);
    this.name = 'AiError';
    this.code = code;
  }
}

/** Текст ошибки для показа пользователю — без кодов и стектрейсов. */
export function aiErrorText(e: unknown): string {
  if (e instanceof AiError) {
    switch (e.code) {
      case 'no_consent':
        return t('Ассистенту нужно согласие. Настройки → Что уходит с телефона');
      case 'no_account':
        return t('Включите синхронизацию в Настройках — она нужна для авторизации.');
      case 'unauthorized':
        return t('Сервер не признал аккаунт. Проверьте синхронизацию.');
      case 'forbidden':
        return t('Аккаунт не в списке разрешённых на сервере.');
      case 'rate_limit':
        return t('Слишком часто. Подождите немного.');
      case 'provider':
        return t('Провайдер отказал: {msg}', { msg: e.message });
      case 'network':
        return t('Нет связи с сервером.');
      case 'aborted':
        return t('Запрос отменён.');
      default:
        return e.message;
    }
  }
  return t('Неизвестная ошибка.');
}

export async function requestChat(params: {
  messages: AiChatMessage[];
  systemPrompt?: string;
  model?: string;
  signal?: AbortSignal;
  /** Определения инструментов (wire-формат OpenAI). Воркер пробрасывает их
   *  провайдеру как есть; заглушка-эхо игнорирует. */
  tools?: unknown[];
  /** Живой стрим: дельты текста по мере генерации. Заглушка отвечает разом. */
  onDelta?: (text: string) => void;
}): Promise<AiReply> {
  // Страховка под окном: и живая модель, и эхо отвечают на нашем сервере, то
  // есть вопрос уходит с телефона в обоих случаях. Проверка — раньше конфига
  // синка: иначе новый человек увидел бы «Включите синхронизацию».
  if (!hasConsent()) throw new AiError('no_consent', 'нет согласия');
  const c = await getSyncConfig();
  if (!c) throw new AiError('no_account', 'синхронизация не настроена');

  let res: Response;
  try {
    res = await fetch(`${WORKER_URL}/ai/chat`, {
      method: 'POST',
      headers: {
        'X-Account': c.accountId,
        Authorization: `Bearer ${c.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: params.messages,
        systemPrompt: params.systemPrompt || '',
        model: params.model,
        ...(params.tools?.length ? { tools: params.tools } : {}),
      }),
      signal: params.signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw new AiError('aborted', 'отменено');
    throw new AiError('network', 'нет связи');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const msg = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
    if (res.status === 401) throw new AiError('unauthorized', msg);
    if (res.status === 403) throw new AiError('forbidden', msg);
    if (res.status === 400) throw new AiError('bad_request', msg);
    if (res.status === 429) throw new AiError('rate_limit', msg);
    throw new AiError('provider', msg);
  }

  // Формат ответа различается по Content-Type: заглушка отвечает готовым JSON,
  // живой провайдер — SSE-потоком (см. worker/src/index.js). Отдельного
  // meta-события или заголовка не нужно, пока формат потока один.
  const type = res.headers.get('Content-Type') || '';
  if (type.includes('text/event-stream')) return readStream(res, params.model, params.onDelta, params.signal);

  const data = (await res.json()) as Partial<AiReply>;
  if (typeof data.content !== 'string') throw new AiError('provider', 'пустой ответ');
  return {
    content: data.content,
    model: typeof data.model === 'string' ? data.model : 'unknown',
    usage: {
      in: Number(data.usage?.in) || 0,
      out: Number(data.usage?.out) || 0,
    },
  };
}

/** Дочитать SSE-поток провайдера до конца (или до отмены). */
async function readStream(
  res: Response,
  model: string | undefined,
  onDelta: ((text: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<AiReply> {
  if (!res.body) throw new AiError('provider', 'пустой поток');
  const st = newStreamState();
  const reader = res.body.getReader();
  // stream:true в декодере обязателен: сетевой чанк может порвать UTF-8
  // символ пополам, и без него русский текст превращался бы в «��».
  const decoder = new TextDecoder('utf-8');
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const added = feedStream(st, decoder.decode(value, { stream: true }));
      if (added && onDelta) onDelta(added);
    }
    const tail = feedStream(st, decoder.decode());
    if (tail && onDelta) onDelta(tail);
  } catch (e) {
    // Отмена генерации — не ошибка потока: накопленный текст выбрасывается
    // выше по стеку тем же путём, что и любая отмена.
    if (signal?.aborted || (e as { name?: string })?.name === 'AbortError') {
      throw new AiError('aborted', 'отменено');
    }
    throw new AiError('network', 'поток оборвался');
  }
  // Ошибка, пришедшая внутри 200-потока (так шлют агрегаторы), — это отказ
  // провайдера, а не пустой успех. Пустой завершившийся поток — тоже отказ:
  // молчаливое «0→0 · готово» выглядит как сбой без объяснения.
  if (st.error) throw new AiError('provider', st.error);
  if (!st.content && !st.toolCalls.length) {
    throw new AiError('provider', st.done ? 'модель вернула пустой ответ' : 'пустой ответ');
  }
  // Слоты без id/name — оборванные дельты вызова: исполнять нечего.
  const calls = st.toolCalls.filter((c) => c.id && c.name);
  return {
    content: st.content,
    model: model ?? 'unknown',
    usage: { in: st.tokensIn ?? 0, out: st.tokensOut ?? 0 },
    finishReason: st.finishReason,
    ...(calls.length
      ? {
          toolCalls: calls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: c.arguments },
          })),
        }
      : {}),
  };
}
