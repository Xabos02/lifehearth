// Ответ ассистента живёт вне экрана «ИИ».
//
// Раньше прогон сидел в компоненте и обрывался вместе с ним: зашёл посреди
// ответа в «Задачи» — при возврате «Запрос отменён.», а уже напечатанное
// пропало. Qwen думает до минуты (замеры 18–20.11.2026: 49–76 с), и за это
// время человек почти наверняка заглянет в другой раздел. Теперь прогон —
// модульный, по одному на чат: экран только подписывается на него и при
// возврате снова видит поток. Ответ дописывается в Dexie и без экрана.
//
// Пока ответ идёт, автоперезагрузка на новую версию ждёт (holdReload) — иначе
// она обрывала ответ молча (живой тест 20.11.2026). Если ждать дольше нельзя
// (потолок отсрочки), перед перезагрузкой сохраняется напечатанное.

import { useSyncExternalStore } from 'react';
import type { LlmChat } from '../../db/types';
import { holdReload, saveBeforeReload } from '../updateReload';
import { runAgent } from './agentLoop';
import { AiError, aiErrorText } from './aiClient';
import { effectiveModel } from './models';
import { addAssistantMessage, addErrorMessage, addUserMessage, chatMessages, toContext } from './llmRepo';

export interface Turn {
  /** Напечатанное к этому моменту; '' — ждём первый токен или пишем ответ в базу. */
  text: string;
  /** Инструмент, который исполняется сейчас, — строка «читаю…». */
  tool: string | null;
}

interface LiveTurn extends Turn {
  ac: AbortController;
}

const live = new Map<string, LiveTurn>();
const subs = new Set<() => void>();

// Состояние неизменяемое: каждое обновление — новый объект, поэтому
// useSyncExternalStore видит изменение по ссылке и не перерисовывает зря.
function put(chatId: string, next: LiveTurn | null) {
  if (next) live.set(chatId, next);
  else live.delete(chatId);
  for (const notify of subs) notify();
}

function subscribe(notify: () => void) {
  subs.add(notify);
  return () => {
    subs.delete(notify);
  };
}

/** Идущий ответ в этом чате или null. */
export function useTurn(chatId: string | null): Turn | null {
  return useSyncExternalStore(subscribe, () => (chatId ? (live.get(chatId) ?? null) : null));
}

/** «Остановить» (и удаление чата): обрываем запрос, напечатанное сохраняется. */
export function stopTurn(chatId: string): void {
  live.get(chatId)?.ac.abort();
}

const isAbort = (e: unknown) =>
  (e instanceof AiError && e.code === 'aborted') || (e as { name?: string } | null)?.name === 'AbortError';

/** Прогон: [вопрос →] история чата → цикл агента → запись ответа. Один на чат:
 *  второй вызов, пока первый идёт, ничего не делает. Вопрос пишется уже
 *  внутри прогона — иначе между его записью и стартом экран успевал увидеть
 *  «вопрос без ответа» и показать под ним «Повторить». */
export async function startTurn(chat: LlmChat, question?: string): Promise<void> {
  if (live.has(chat.id)) return;
  const ac = new AbortController();
  put(chat.id, { text: '', tool: null, ac });
  const mine = () => live.get(chat.id)?.ac === ac;
  const release = holdReload();
  // Новый круг цикла (после чтения данных) — с новой строки, как в готовом
  // ответе, где круги склеивает '\n\n'.
  let newRound = false;
  const update = (patch: Partial<Turn>) => {
    const cur = live.get(chat.id);
    if (cur?.ac === ac) put(chat.id, { ...cur, ...patch });
  };
  let partialSaved = false;
  const savePartial = async () => {
    const text = mine() ? (live.get(chat.id)?.text ?? '') : '';
    if (partialSaved || !text.trim()) return false;
    partialSaved = true;
    // Токенов обрыв не сообщает: счётчик у такого ответа скрыт (finishReason).
    await addAssistantMessage(chat.id, {
      content: text,
      model: effectiveModel(chat.model),
      usage: { in: 0, out: 0 },
      finishReason: 'aborted',
    });
    return true;
  };
  const unsave = saveBeforeReload(savePartial);
  try {
    if (question) await addUserMessage(chat, question);
    const reply = await runAgent({
      messages: toContext(await chatMessages(chat.id)),
      systemPrompt: chat.systemPrompt,
      model: effectiveModel(chat.model),
      signal: ac.signal,
      dataTools: chat.dataTools === true,
      onDelta: (piece) => {
        const prev = live.get(chat.id)?.text ?? '';
        update({ text: prev + (newRound && prev ? '\n\n' : '') + piece, tool: null });
        newRound = false;
      },
      onTool: (label) => {
        newRound = true;
        update({ tool: label });
      },
    });
    // Поток прячем ДО записи (иначе ответ на мгновение виден дважды), но
    // прогон не снимаем, пока ответ не в базе: снятый раньше открывал окно,
    // где под вопросом мелькало «Повторить» и вторая отправка шла невидимо.
    update({ text: '', tool: null });
    await addAssistantMessage(chat.id, reply);
  } catch (e) {
    // Обрыв посреди текста — оставляем напечатанное, а не одну карточку.
    const kept = await savePartial();
    if (!isAbort(e)) await addErrorMessage(chat.id, aiErrorText(e));
    else if (!kept) await addErrorMessage(chat.id, aiErrorText(new AiError('aborted', '')));
  } finally {
    unsave();
    if (mine()) put(chat.id, null);
    release();
  }
}
