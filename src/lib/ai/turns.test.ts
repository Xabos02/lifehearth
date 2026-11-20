import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmChat } from '../../db/types';

// Прогон ответа вне экрана: «Остановить» и обрыв сохраняют напечатанное, пока
// ответ идёт (и пишется в базу) второй прогон не стартует, а автоперезагрузка
// придержана (живой тест и ревью 20.11.2026).

const repo = vi.hoisted(() => ({
  addAssistantMessage: vi.fn<(...a: unknown[]) => Promise<object>>(async () => ({})),
  addErrorMessage: vi.fn<(...a: unknown[]) => Promise<object>>(async () => ({})),
  addUserMessage: vi.fn<(...a: unknown[]) => Promise<object>>(async () => ({})),
  chatMessages: vi.fn(async () => []),
  toContext: vi.fn(() => []),
}));
vi.mock('./llmRepo', () => repo);

const reload = vi.hoisted(() => ({ release: vi.fn(), holdReload: vi.fn(), unsave: vi.fn(), saveBeforeReload: vi.fn() }));
vi.mock('../updateReload', () => ({ holdReload: reload.holdReload, saveBeforeReload: reload.saveBeforeReload }));

const agent = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock('./agentLoop', () => agent);

const { startTurn, stopTurn } = await import('./turns');
const { AiError } = await import('./aiClient');

const chat = { id: 'c1', model: '@cf/google/gemma-4-26b-a4b-it', dataTools: false, systemPrompt: '' } as LlmChat;

type Params = { onDelta: (s: string) => void; signal: AbortSignal };

beforeEach(() => {
  vi.clearAllMocks();
  reload.holdReload.mockReturnValue(reload.release);
  reload.saveBeforeReload.mockReturnValue(reload.unsave);
});

describe('startTurn', () => {
  it('«Остановить» посреди текста сохраняет напечатанное с пометкой, перезагрузку отпускает', async () => {
    agent.runAgent.mockImplementation(
      ({ onDelta, signal }: Params) =>
        new Promise((_, reject) => {
          onDelta('Первая часть');
          signal.addEventListener('abort', () => reject(new AiError('aborted', 'отменено')));
        }),
    );
    const done = startTurn(chat, 'вопрос');
    await vi.waitFor(() => expect(agent.runAgent).toHaveBeenCalled());
    expect(repo.addUserMessage).toHaveBeenCalledWith(chat, 'вопрос');
    expect(reload.release).not.toHaveBeenCalled();

    stopTurn('c1');
    await done;
    expect(repo.addAssistantMessage).toHaveBeenCalledWith('c1', expect.objectContaining({ content: 'Первая часть', finishReason: 'aborted' }));
    expect(repo.addErrorMessage).not.toHaveBeenCalled();
    expect(reload.release).toHaveBeenCalledTimes(1);
    expect(reload.unsave).toHaveBeenCalledTimes(1);
  });

  it('остановка до первого слова — карточка «Запрос отменён.», а не пустой ответ', async () => {
    agent.runAgent.mockImplementation(
      ({ signal }: Params) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    const done = startTurn(chat);
    await vi.waitFor(() => expect(agent.runAgent).toHaveBeenCalled());
    stopTurn('c1');
    await done;
    expect(repo.addAssistantMessage).not.toHaveBeenCalled();
    expect(repo.addErrorMessage).toHaveBeenCalledWith('c1', 'Запрос отменён.');
  });

  it('обрыв сети посреди текста: напечатанное остаётся, следом карточка ошибки', async () => {
    agent.runAgent.mockImplementation(({ onDelta }: Params) => {
      onDelta('Половина');
      return Promise.reject(new AiError('network', 'поток оборвался'));
    });
    await startTurn(chat);
    expect(repo.addAssistantMessage).toHaveBeenCalledWith('c1', expect.objectContaining({ content: 'Половина', finishReason: 'aborted' }));
    expect(repo.addErrorMessage).toHaveBeenCalledWith('c1', 'Нет связи с сервером.');
  });

  it('пока ответ пишется в базу, прогон ещё идёт: повторная отправка не стартует второй запрос', async () => {
    agent.runAgent.mockResolvedValue({ content: 'Ответ', model: chat.model, usage: { in: 1, out: 1 } });
    repo.addAssistantMessage.mockImplementationOnce(async () => {
      await startTurn(chat, 'нажали «Повторить» в окне записи');
      return {};
    });
    await startTurn(chat, 'вопрос');
    expect(agent.runAgent).toHaveBeenCalledTimes(1);
    expect(repo.addUserMessage).toHaveBeenCalledTimes(1);
  });
});
