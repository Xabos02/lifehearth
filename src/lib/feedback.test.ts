// Отклик на касания: выключатель обязан глушить вибрацию целиком, а до первого
// касания страницы вибрация не зовётся вовсе (Chromium её блокирует и пишет в
// консоль). Тактильный щелчок iPhone и щелчок барабана — e2e/feedback.spec.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buzz, feedbackOn, setFeedbackOn } from './feedback';

describe('buzz', () => {
  const vibrate = vi.fn();

  beforeEach(() => {
    vibrate.mockClear();
    setFeedbackOn(true);
    vi.stubGlobal('navigator', { vibrate, userActivation: { hasBeenActive: true } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('вибрирует 10 мс по умолчанию и столько, сколько попросили', () => {
    buzz();
    buzz(12);
    expect(vibrate.mock.calls).toEqual([[10], [12]]);
  });

  it('выключатель глушит вибрацию и возвращает её', () => {
    setFeedbackOn(false);
    expect(feedbackOn()).toBe(false);
    buzz();
    expect(vibrate).not.toHaveBeenCalled();
    setFeedbackOn(true);
    buzz();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('до первого касания страницы молчит', () => {
    vi.stubGlobal('navigator', { vibrate, userActivation: { hasBeenActive: false } });
    buzz();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('без Vibration API (iPhone) и без userActivation не падает', () => {
    vi.stubGlobal('navigator', {});
    expect(() => buzz()).not.toThrow();
    vi.stubGlobal('navigator', { vibrate });
    buzz();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });
});
