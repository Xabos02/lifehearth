import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Перезагрузка на новую версию не должна стирать набранное (аудит 18.11.2026,
// N6): пока человек печатает, она ждёт, а перед самой перезагрузкой
// дожидается сохранения. DOM здесь подставной — vitest гоняется в node.

const call = { status: 'idle', subs: new Set<() => void>() };
vi.mock('./family/familyCall', () => ({
  callManager: {
    getSnapshot: () => ({ status: call.status }),
    subscribe: (cb: () => void) => {
      call.subs.add(cb);
      return () => call.subs.delete(cb);
    },
  },
}));

const editor = { isContentEditable: true, tagName: 'DIV' };
const button = { isContentEditable: false, tagName: 'BUTTON' };

let doc: EventTarget & { activeElement: unknown; visibilityState: string };
let reload: ReturnType<typeof vi.fn>;

async function load() {
  vi.resetModules();
  return import('./updateReload');
}

beforeEach(() => {
  vi.useFakeTimers();
  call.status = 'idle';
  call.subs.clear();
  doc = Object.assign(new EventTarget(), { activeElement: button as unknown, visibilityState: 'visible' });
  reload = vi.fn();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { location: { reload } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reloadWhenIdle', () => {
  it('пока фокус в тексте — не перезагружает; ушёл фокус — сохраняет и перезагружает', async () => {
    const { reloadWhenIdle, saveBeforeReload, AFTER_FOCUS_MS } = await load();
    let saved = false;
    let finishSave = () => {};
    saveBeforeReload(
      () =>
        new Promise<void>((done) => {
          finishSave = () => {
            saved = true;
            done();
          };
        }),
    );
    doc.activeElement = editor;

    reloadWhenIdle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reload).not.toHaveBeenCalled();

    doc.activeElement = button;
    doc.dispatchEvent(new Event('focusout'));
    // Пауза после ухода фокуса: клик по «Сохранить» в шторке успевает дойти.
    await vi.advanceTimersByTimeAsync(AFTER_FOCUS_MS - 100);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    // Сохранение ещё идёт — перезагрузка его ждёт.
    expect(reload).not.toHaveBeenCalled();
    finishSave();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('уход в фон перезагружает и с фокусом в тексте', async () => {
    const { reloadWhenIdle } = await load();
    doc.activeElement = editor;
    reloadWhenIdle();
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('у отсрочки потолок: набор не держит старую версию вечно', async () => {
    const { reloadWhenIdle, MAX_DEFER_MS } = await load();
    doc.activeElement = editor;
    reloadWhenIdle();
    await vi.advanceTimersByTimeAsync(MAX_DEFER_MS - 1000);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('зависшее сохранение не держит перезагрузку дольше пары секунд', async () => {
    const { reloadWhenIdle, saveBeforeReload } = await load();
    saveBeforeReload(() => new Promise(() => {}));
    reloadWhenIdle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('звонок по-прежнему откладывает перезагрузку до конца', async () => {
    const { reloadWhenIdle } = await load();
    call.status = 'active';
    reloadWhenIdle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reload).not.toHaveBeenCalled();
    call.status = 'idle';
    for (const cb of [...call.subs]) cb();
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
