// Сигнал конца круга — синтез через Web Audio, без звуковых файлов: нечего
// грузить, нечего кэшировать, и на всех платформах он одинаковый.
//
// Честная граница: сигнал слышен, пока приложение открыто. В свёрнутом PWA на
// iPhone код не работает, и о конце круга сообщает фоновый пуш со стандартным
// звуком системы — свой звук в веб-уведомление iOS положить нельзя.

export type AlarmType = 'soft' | 'bell' | 'double' | 'gong' | 'none';

// «Только вибрация» здесь нарочно нет: Vibration API в Safari iOS не
// поддерживается ни в одной версии (caniuse.com/vibration), и на iPhone такой
// пункт равнялся бы тишине с обещанием. Вибрация идёт бонусом там, где есть.
export const ALARM_OPTIONS: { value: AlarmType; label: string }[] = [
  { value: 'soft', label: 'Мягкий' },
  { value: 'bell', label: 'Колокольчик' },
  { value: 'double', label: 'Двойной' },
  { value: 'gong', label: 'Гонг' },
  { value: 'none', label: 'Без звука' },
];

/** Объявить системе, что за звук идёт: без этого Web Audio в Safari — категория
 *  ambient, и её глушит переключатель беззвучного режима. Audio Session API есть
 *  в Safari 17+, в остальных — тихо ничего. На устройстве не проверено. */
export function setAudioSession(type: 'playback' | 'transient'): void {
  try {
    const nav = navigator as unknown as { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = type;
  } catch {
    /* нет API */
  }
}

let audioCtx: AudioContext | null = null;

/** Общий AudioContext экрана. Создаётся по жесту (иначе iOS его не пустит)
 *  и дальше живёт; resume — на случай, если система его усыпила. */
export function ensureAudio(): AudioContext | null {
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!audioCtx) audioCtx = new AC();
    void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

/** Одна нота: частота, форма, громкость, длительность, задержка от «сейчас». */
function tone(
  ac: AudioContext,
  freq: number,
  type: OscillatorType,
  peak: number,
  dur: number,
  at = 0,
): void {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.connect(g);
  g.connect(ac.destination);
  o.type = type;
  o.frequency.value = freq;
  const t0 = ac.currentTime + at;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.start(t0);
  o.stop(t0 + dur);
}

/** Проиграть сигнал. Вибрация — везде, где она есть (iOS её игнорирует). */
export function playAlarm(kind: AlarmType): void {
  navigator.vibrate?.(200);
  if (kind === 'none') return;
  setAudioSession('transient');
  const ac = ensureAudio();
  if (ac) {
    switch (kind) {
      case 'soft':
        tone(ac, 880, 'sine', 0.35, 0.6);
        break;
      case 'bell':
        // Основной тон и две обертона, затухающие быстрее, — так звенит металл.
        tone(ac, 1046, 'triangle', 0.3, 1.2);
        tone(ac, 2093, 'sine', 0.12, 0.7);
        tone(ac, 3136, 'sine', 0.05, 0.4);
        break;
      case 'double':
        tone(ac, 880, 'sine', 0.35, 0.18);
        tone(ac, 880, 'sine', 0.35, 0.18, 0.3);
        break;
      case 'gong':
        // Низкий, долгий, с нестройными обертонами: гонг, а не орган.
        tone(ac, 196, 'sine', 0.4, 2.2);
        tone(ac, 392, 'sine', 0.18, 1.8);
        tone(ac, 587, 'sine', 0.08, 1.2);
        tone(ac, 831, 'triangle', 0.05, 0.9);
        break;
    }
  }
}
