// Присутствие собеседников для шапки чата: «печатает…», «в сети»,
// «был(а) в сети…», «2 в сети». Считает ChatTab (у него подписки на
// присутствие и набор текста), показывает шапка экрана — как в макете,
// под именем, а не отдельной строкой над лентой: та стоила переписке высоты.

export interface ChatPresence {
  familyId: string;
  text: string | null;
  /** typing — золотом, online — зелёным, иначе серым. */
  tone: 'typing' | 'online' | 'plain';
  /** Кто из собеседников сейчас в сети — для точки на аватаре. */
  onlineIds: string[];
}

let current: ChatPresence | null = null;
const subs = new Set<() => void>();

export function setChatPresence(p: ChatPresence | null): void {
  if (
    current &&
    p &&
    current.familyId === p.familyId &&
    current.text === p.text &&
    current.tone === p.tone &&
    current.onlineIds.join() === p.onlineIds.join()
  )
    return;
  current = p;
  for (const cb of subs) cb();
}

export function chatPresence(): ChatPresence | null {
  return current;
}

export function subscribeChatPresence(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}
