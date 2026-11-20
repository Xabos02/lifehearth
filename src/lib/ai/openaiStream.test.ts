import { describe, expect, it } from 'vitest';
import { feedStream, newStreamState } from './openaiStream';

// Парсер обязан переваривать поток, порезанный где угодно: сетевые чанки не
// уважают границы SSE-событий. Каждый тест кормит один и тот же поток разной
// нарезкой и ждёт одинаковый итог.

const ev = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (text: string) => ev({ choices: [{ delta: { content: text }, finish_reason: null }] });

describe('feedStream', () => {
  it('собирает текст из дельт и отдаёт добавку каждого куска', () => {
    const st = newStreamState();
    expect(feedStream(st, delta('При'))).toBe('При');
    expect(feedStream(st, delta('вет'))).toBe('вет');
    expect(st.content).toBe('Привет');
  });

  it('событие, порванное посреди JSON, склеивается через буфер', () => {
    const st = newStreamState();
    const whole = delta('целиком');
    let added = '';
    // Режем по одному символу — худший случай нарезки.
    for (const ch of whole) added += feedStream(st, ch);
    expect(added).toBe('целиком');
    expect(st.content).toBe('целиком');
  });

  it('usage финального чанка и finish_reason доезжают до состояния', () => {
    const st = newStreamState();
    feedStream(st, delta('ответ'));
    feedStream(st, ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    feedStream(st, ev({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
    feedStream(st, 'data: [DONE]\n\n');
    expect(st.finishReason).toBe('stop');
    expect(st.tokensIn).toBe(11);
    expect(st.tokensOut).toBe(7);
    expect(st.done).toBe(true);
  });

  it('finish_reason=length не теряется среди дельт', () => {
    const st = newStreamState();
    feedStream(st, delta('начало') + ev({ choices: [{ delta: {}, finish_reason: 'length' }] }));
    expect(st.finishReason).toBe('length');
    expect(st.content).toBe('начало');
  });

  it('CRLF-разделители и посторонние строки не ломают разбор', () => {
    const st = newStreamState();
    feedStream(st, ': keep-alive\r\n' + delta('ok').replace(/\n/g, '\r\n') + 'event: noise\r\n');
    expect(st.content).toBe('ok');
  });

  it('битое событие пропускается, поток продолжается', () => {
    const st = newStreamState();
    feedStream(st, 'data: {оборвано посереди\n' + delta('живой'));
    expect(st.content).toBe('живой');
  });

  // tool use (этап 3): id и имя приходят первым чанком вызова, аргументы —
  // JSON-строкой кусками произвольного размера, сшиваются по index.
  it('вызов инструмента собирается из рваных дельт аргументов', () => {
    const st = newStreamState();
    const c1 = ev({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_tasks', arguments: '' } }] } }],
    });
    const c2 = ev({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"status":' } }] } }] });
    const c3 = ev({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"active"}' } }] } }] });
    const fin = ev({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    // Худшая нарезка — по символу: границы чанков не совпадают с событиями.
    for (const ch of c1 + c2 + c3 + fin) feedStream(st, ch);
    expect(st.toolCalls).toEqual([{ id: 'call_1', name: 'list_tasks', arguments: '{"status":"active"}' }]);
    expect(st.finishReason).toBe('tool_calls');
  });

  it('ошибка внутри 200-потока ловится, а не глотается как пустой успех', () => {
    const st = newStreamState();
    feedStream(st, ev({ error: { message: 'model not available on your plan', code: 403 } }) + 'data: [DONE]\n\n');
    expect(st.error).toBe('model not available on your plan');
    expect(st.done).toBe(true);
    // Строковый вариант формата — тоже провайдерская реальность.
    const st2 = newStreamState();
    feedStream(st2, ev({ error: 'insufficient balance' }));
    expect(st2.error).toBe('insufficient balance');
  });

  it('два параллельных вызова не перемешиваются между index', () => {
    const st = newStreamState();
    feedStream(
      st,
      ev({
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'a', function: { name: 'list_tasks', arguments: '{}' } },
              { index: 1, id: 'b', function: { name: 'list_goals', arguments: '' } },
            ],
          },
        }],
      }) + ev({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{}' } }] } }] }),
    );
    expect(st.toolCalls).toEqual([
      { id: 'a', name: 'list_tasks', arguments: '{}' },
      { id: 'b', name: 'list_goals', arguments: '{}' },
    ]);
  });

  it('два вызова под одним index с разными id — два вызова, а не склейка «{…}{…}»', () => {
    // Так шлёт Gemma на Workers AI (живой тест 20.11.2026): склейка уходила
    // в историю, и модель отвечала 8007 «arguments must be valid JSON».
    const st = newStreamState();
    const call = (id: string | null, name: string | null, args: string) =>
      ev({ choices: [{ delta: { tool_calls: [{ id, index: 1, type: 'function', function: { name, arguments: args } }] } }] });
    feedStream(
      st,
      call('call_a', 'search_notes', '') +
        call(null, null, '{"query": "идеи"}') +
        call('call_b', 'search_notes', '') +
        call(null, null, '{"query": "список"}'),
    );
    expect(st.toolCalls).toEqual([
      { id: 'call_a', name: 'search_notes', arguments: '{"query": "идеи"}' },
      { id: 'call_b', name: 'search_notes', arguments: '{"query": "список"}' },
    ]);
  });
});
