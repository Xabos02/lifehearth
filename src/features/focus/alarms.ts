// Сигнал конца круга — синтез через Web Audio, без звуковых файлов: нечего
// грузить, нечего кэшировать, и на всех платформах он одинаковый.
//
// Набор собран по опыту Focus To-Do (скрины владельца 12.09.2026): там
// тридцать мелодий и отдельный выбор для конца фокуса и конца перерыва.
// Здесь пятнадцать — каждая узнаваема с первой секунды и не похожа на
// соседнюю; тридцать «Музыка1/2/3» различить нельзя, и выбирать их незачем.
//
// Честная граница: сигнал слышен, пока приложение открыто. В свёрнутом PWA на
// iPhone код не работает, и о конце круга сообщает фоновый пуш со стандартным
// звуком системы — свой звук в веб-уведомление iOS положить нельзя.

export type AlarmType =
  | 'none'
  | 'soft'
  | 'bell'
  | 'double'
  | 'gong'
  | 'timer'
  | 'ring'
  | 'bike'
  | 'chimes'
  | 'alarmclock'
  | 'piano'
  | 'cuckoo'
  | 'birds'
  | 'fanfare'
  | 'whistle';

export interface AlarmOption {
  value: AlarmType;
  label: string;
  /** Длительность в секундах — подпись в списке, как в Focus To-Do. */
  seconds: number;
}

// «Только вибрация» здесь нарочно нет: Vibration API в Safari iOS не
// поддерживается ни в одной версии (caniuse.com/vibration), и на iPhone такой
// пункт равнялся бы тишине с обещанием. Вибрация идёт бонусом там, где есть.
export const ALARM_OPTIONS: AlarmOption[] = [
  { value: 'none', label: 'Без звука', seconds: 0 },
  { value: 'soft', label: 'Мягкий', seconds: 1 },
  { value: 'bell', label: 'Колокольчик', seconds: 1 },
  { value: 'double', label: 'Двойной', seconds: 1 },
  { value: 'gong', label: 'Гонг', seconds: 2 },
  { value: 'timer', label: 'Таймер', seconds: 2 },
  { value: 'ring', label: 'Звонок', seconds: 2 },
  { value: 'bike', label: 'Велозвонок', seconds: 1 },
  { value: 'chimes', label: 'Ветряные колокольчики', seconds: 3 },
  { value: 'alarmclock', label: 'Будильник', seconds: 2 },
  { value: 'piano', label: 'Пианино', seconds: 2 },
  { value: 'cuckoo', label: 'Кукушка', seconds: 1 },
  { value: 'birds', label: 'Птицы', seconds: 2 },
  { value: 'fanfare', label: 'Фанфары', seconds: 3 },
  { value: 'whistle', label: 'Свисток', seconds: 1 },
];

export function alarmOption(kind: AlarmType): AlarmOption {
  return ALARM_OPTIONS.find((a) => a.value === kind) ?? ALARM_OPTIONS[1];
}

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

interface ToneOpts {
  /** Форма волны. */
  type?: OscillatorType;
  /** Пик громкости 0..1 до общей громкости. */
  peak?: number;
  /** Задержка от «сейчас», с. */
  at?: number;
  /** Атака, с: у колокола 0,005, у духовых 0,05. */
  attack?: number;
  /** Куда уехать частотой к концу ноты (свисток, птицы). */
  glideTo?: number;
}

/** Одна нота через общий регулятор громкости. */
function tone(ac: AudioContext, out: GainNode, freq: number, dur: number, o: ToneOpts = {}): void {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.connect(g);
  g.connect(out);
  osc.type = o.type ?? 'sine';
  const t0 = ac.currentTime + (o.at ?? 0);
  osc.frequency.setValueAtTime(freq, t0);
  if (o.glideTo) osc.frequency.exponentialRampToValueAtTime(o.glideTo, t0 + dur);
  const peak = o.peak ?? 0.3;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack ?? 0.02));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Короткий шумовой удар (перкуссия, дыхание свистка). */
function burst(ac: AudioContext, out: GainNode, dur: number, peak: number, at = 0, hp = 2000): void {
  const len = Math.ceil(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const f = ac.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = hp;
  const g = ac.createGain();
  const t0 = ac.currentTime + at;
  g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f);
  f.connect(g);
  g.connect(out);
  src.start(t0);
}

/** Проиграть сигнал с громкостью 0..1. Вибрация — везде, где она есть (iOS
 *  её игнорирует). */
export function playAlarm(kind: AlarmType, volume = 0.8): void {
  navigator.vibrate?.(200);
  if (kind === 'none' || volume <= 0) return;
  setAudioSession('transient');
  const ac = ensureAudio();
  if (!ac) return;
  const out = ac.createGain();
  out.gain.value = Math.max(0, Math.min(1, volume));
  out.connect(ac.destination);
  synth(ac, out, kind);
}

function synth(ac: AudioContext, out: GainNode, kind: AlarmType): void {
  switch (kind) {
    case 'soft':
      tone(ac, out, 880, 0.6, { peak: 0.35 });
      break;
    case 'bell':
      // Основной тон и два обертона, затухающие быстрее, — так звенит металл.
      tone(ac, out, 1046, 1.2, { type: 'triangle', peak: 0.3, attack: 0.005 });
      tone(ac, out, 2093, 0.7, { peak: 0.12, attack: 0.005 });
      tone(ac, out, 3136, 0.4, { peak: 0.05, attack: 0.005 });
      break;
    case 'double':
      tone(ac, out, 880, 0.18, { peak: 0.35 });
      tone(ac, out, 880, 0.18, { peak: 0.35, at: 0.3 });
      break;
    case 'gong':
      // Низкий, долгий, с нестройными обертонами: гонг, а не орган.
      tone(ac, out, 196, 2.2, { peak: 0.4, attack: 0.01 });
      tone(ac, out, 392, 1.8, { peak: 0.18, attack: 0.01 });
      tone(ac, out, 587, 1.2, { peak: 0.08, attack: 0.01 });
      tone(ac, out, 831, 0.9, { type: 'triangle', peak: 0.05, attack: 0.01 });
      break;
    case 'timer':
      // Кухонный таймер: четыре сухих пика, каждый чуть выше.
      [0, 0.35, 0.7, 1.05].forEach((at, i) =>
        tone(ac, out, 1200 + i * 120, 0.16, { type: 'square', peak: 0.12, at, attack: 0.005 }),
      );
      break;
    case 'ring':
      // Телефонная трель: две ноты чередуются быстро, два «звонка» с паузой.
      for (let r = 0; r < 2; r++)
        for (let i = 0; i < 8; i++)
          tone(ac, out, i % 2 ? 1568 : 1319, 0.07, { type: 'triangle', peak: 0.16, at: r * 1.0 + i * 0.075, attack: 0.005 });
      break;
    case 'bike':
      // Два быстрых металлических «дзынь».
      [0, 0.22].forEach((at) => {
        tone(ac, out, 2637, 0.35, { type: 'triangle', peak: 0.22, at, attack: 0.003 });
        tone(ac, out, 3951, 0.25, { peak: 0.08, at, attack: 0.003 });
      });
      break;
    case 'chimes': {
      // Ветряные колокольчики: пентатоника вразнобой, долгое затухание.
      const notes = [1319, 1480, 1760, 1976, 2349, 2637];
      [0, 0.18, 0.31, 0.55, 0.78, 0.9, 1.25, 1.6].forEach((at, i) =>
        tone(ac, out, notes[(i * 5 + 2) % notes.length], 1.4, { type: 'triangle', peak: 0.14, at, attack: 0.004 }),
      );
      break;
    }
    case 'alarmclock':
      // Будильник: резкое чередование двух тонов, восемь ударов.
      for (let i = 0; i < 8; i++)
        tone(ac, out, i % 2 ? 1760 : 1400, 0.11, { type: 'square', peak: 0.1, at: i * 0.13, attack: 0.003 });
      break;
    case 'piano':
      // Арпеджио до-мажор с длинным последним аккордом.
      [523, 659, 784].forEach((f, i) => tone(ac, out, f, 0.5, { type: 'triangle', peak: 0.22, at: i * 0.16, attack: 0.008 }));
      [523, 659, 784, 1046].forEach((f) => tone(ac, out, f, 1.3, { type: 'triangle', peak: 0.12, at: 0.5, attack: 0.008 }));
      break;
    case 'cuckoo':
      // Кукушка: терция вниз, мягко, дважды.
      [0, 0.55].forEach((at) => {
        tone(ac, out, 740, 0.22, { peak: 0.3, at, attack: 0.03 });
        tone(ac, out, 587, 0.28, { peak: 0.3, at: at + 0.25, attack: 0.03 });
      });
      break;
    case 'birds':
      // Птицы: короткие свипы вверх, разной высоты.
      [
        [0, 2400, 3200],
        [0.16, 2600, 3600],
        [0.5, 2200, 3000],
        [0.62, 2800, 3900],
        [0.74, 2500, 3300],
        [1.2, 2700, 3800],
        [1.32, 2300, 3100],
      ].forEach(([at, from, to]) => tone(ac, out, from, 0.09, { peak: 0.14, at, attack: 0.01, glideTo: to }));
      break;
    case 'fanfare': {
      // Фанфары: три ступени вверх и мажорный аккорд, медные — пила с мягкой атакой.
      const brass = (f: number, dur: number, at: number, peak = 0.09) =>
        tone(ac, out, f, dur, { type: 'sawtooth', peak, at, attack: 0.05 });
      brass(523, 0.28, 0);
      brass(659, 0.28, 0.3);
      brass(784, 0.28, 0.6);
      [523, 659, 784, 1046].forEach((f) => brass(f, 1.6, 0.9, 0.07));
      break;
    }
    case 'whistle':
      // Свисток судьи: подъём частоты и шум дыхания.
      tone(ac, out, 2000, 0.55, { peak: 0.28, attack: 0.02, glideTo: 2700 });
      burst(ac, out, 0.5, 0.05, 0, 3000);
      break;
    case 'none':
      break;
  }
}
