import { ensureAudio, setAudioSession } from './alarms';

// Фоновый шум на время работы — синтез через Web Audio, без файлов.
//
// Набор — по опыту Focus To-Do (скрины владельца 12.09.2026): дождь, ветер,
// море, ручей, костёр, сверчки, тиканье, метроном. Кофейни и библиотеки нет:
// голоса и шорох страниц шумом не синтезируются, а плохая имитация хуже
// отсутствия. Всё, что здесь, — узнаваемо с первых секунд.
//
// Громкость идёт через один GainNode: слайдер меняет его на ходу, без
// перезапуска источников.

export type NoiseType =
  | 'none'
  | 'white'
  | 'pink'
  | 'brown'
  | 'rain'
  | 'wind'
  | 'waves'
  | 'stream'
  | 'fire'
  | 'crickets'
  | 'tick'
  | 'metronome';

export const NOISE_OPTIONS: { value: NoiseType; label: string }[] = [
  { value: 'none', label: 'Тишина' },
  { value: 'rain', label: 'Дождь' },
  { value: 'wind', label: 'Ветер' },
  { value: 'waves', label: 'Море' },
  { value: 'stream', label: 'Ручей' },
  { value: 'fire', label: 'Костёр' },
  { value: 'crickets', label: 'Сверчки' },
  { value: 'tick', label: 'Тиканье' },
  { value: 'metronome', label: 'Метроном' },
  { value: 'white', label: 'Белый шум' },
  { value: 'pink', label: 'Розовый шум' },
  { value: 'brown', label: 'Коричневый шум' },
];

export function noiseLabel(kind: NoiseType): string {
  return NOISE_OPTIONS.find((n) => n.value === kind)?.label ?? 'Тишина';
}

type Color = 'white' | 'pink' | 'brown';

function noiseBuffer(ac: AudioContext, color: Color, seconds = 3): AudioBuffer {
  const len = ac.sampleRate * seconds;
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  if (color === 'brown') {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  } else if (color === 'pink') {
    let b0 = 0,
      b1 = 0,
      b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    }
  } else {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return buf;
}

interface Player {
  stop: () => void;
}

let current: Player | null = null;
let master: GainNode | null = null;

export function stopNoise(): void {
  current?.stop();
  current = null;
}

/** Громкость на ходу, 0..1. */
export function setNoiseVolume(volume: number): void {
  if (master) master.gain.value = Math.max(0, Math.min(1, volume));
}

/** Запустить шум. Повторный вызов с тем же видом перезапускает — вызывающий
 *  сам решает, когда это нужно. */
export function startNoise(kind: NoiseType, volume: number): void {
  stopNoise();
  if (kind === 'none') return;
  setAudioSession('playback');
  const ac = ensureAudio();
  if (!ac) return;
  master = ac.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume));
  master.connect(ac.destination);
  current = build(ac, master, kind);
}

/** Зациклить цветной шум через фильтр с заданной громкостью. */
function loop(
  ac: AudioContext,
  out: AudioNode,
  color: Color,
  gainValue: number,
  filter?: (f: BiquadFilterNode) => void,
): { src: AudioBufferSourceNode; gain: GainNode } {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac, color);
  src.loop = true;
  const gain = ac.createGain();
  gain.gain.value = gainValue;
  if (filter) {
    const f = ac.createBiquadFilter();
    filter(f);
    src.connect(f);
    f.connect(gain);
  } else src.connect(gain);
  gain.connect(out);
  src.start();
  return { src, gain };
}

/** Медленная волна громкости (ветер, море): синус через LFO на gain. */
function swell(ac: AudioContext, gain: GainNode, periodSec: number, depth: number): OscillatorNode {
  const lfo = ac.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 1 / periodSec;
  const amp = ac.createGain();
  amp.gain.value = depth;
  lfo.connect(amp);
  amp.connect(gain.gain);
  lfo.start();
  return lfo;
}

/** Планировщик коротких событий (треск, стрекот, тик): setInterval с
 *  опережением, события ложатся по часам контекста внутри колбэка. */
function scheduler(tick: () => void, everyMs: number): () => void {
  const id = setInterval(tick, everyMs);
  tick();
  return () => clearInterval(id);
}

function click(ac: AudioContext, out: AudioNode, at: number, freq: number, peak: number, dur = 0.03): void {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = 'square';
  o.frequency.value = freq;
  g.gain.setValueAtTime(peak, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g);
  g.connect(out);
  o.start(at);
  o.stop(at + dur + 0.01);
}

function build(ac: AudioContext, out: GainNode, kind: NoiseType): Player {
  const stops: (() => void)[] = [];
  const stopSrc = (n: { src: AudioBufferSourceNode }) => () => {
    try {
      n.src.stop();
    } catch {
      /* уже */
    }
  };
  switch (kind) {
    case 'white':
      stops.push(stopSrc(loop(ac, out, 'white', 0.1)));
      break;
    case 'pink':
      stops.push(stopSrc(loop(ac, out, 'pink', 0.1, (f) => ((f.type = 'lowpass'), (f.frequency.value = 1400)))));
      break;
    case 'brown':
      stops.push(stopSrc(loop(ac, out, 'brown', 0.16, (f) => ((f.type = 'lowpass'), (f.frequency.value = 500)))));
      break;
    case 'rain': {
      // Ровная пелена плюс редкие крупные капли.
      stops.push(stopSrc(loop(ac, out, 'white', 0.09, (f) => ((f.type = 'lowpass'), (f.frequency.value = 3200)))));
      stops.push(
        scheduler(
          () => {
            for (let i = 0; i < 3; i++) {
              const at = ac.currentTime + Math.random() * 0.5;
              click(ac, out, at, 1800 + Math.random() * 2500, 0.012, 0.012);
            }
          },
          500,
        ),
      );
      break;
    }
    case 'wind': {
      // Коричневый шум, у которого гуляет и громкость, и срез фильтра.
      const n = loop(ac, out, 'brown', 0.22, (f) => ((f.type = 'lowpass'), (f.frequency.value = 700)));
      const lfo = swell(ac, n.gain, 7, 0.12);
      stops.push(stopSrc(n), () => lfo.stop());
      break;
    }
    case 'waves': {
      // Волна накатывает ~9 секунд: розовый шум с глубокой медленной волной.
      const n = loop(ac, out, 'pink', 0.16, (f) => ((f.type = 'lowpass'), (f.frequency.value = 1100)));
      const lfo = swell(ac, n.gain, 9, 0.13);
      stops.push(stopSrc(n), () => lfo.stop());
      break;
    }
    case 'stream': {
      // Ручей — светлее дождя, с быстрым журчанием.
      const n = loop(ac, out, 'pink', 0.12, (f) => ((f.type = 'bandpass'), (f.frequency.value = 2600), (f.Q.value = 0.7)));
      const lfo = swell(ac, n.gain, 0.37, 0.04);
      stops.push(stopSrc(n), () => lfo.stop());
      break;
    }
    case 'fire': {
      // Гул углей и случайный треск.
      stops.push(stopSrc(loop(ac, out, 'brown', 0.12, (f) => ((f.type = 'lowpass'), (f.frequency.value = 350)))));
      stops.push(
        scheduler(
          () => {
            const n = Math.random() < 0.6 ? 1 : 3;
            for (let i = 0; i < n; i++) {
              const at = ac.currentTime + Math.random() * 0.4;
              click(ac, out, at, 2500 + Math.random() * 4000, 0.03 + Math.random() * 0.05, 0.02);
            }
          },
          400,
        ),
      );
      break;
    }
    case 'crickets': {
      // Стрекот: пачки коротких высоких импульсов, чуть неровные.
      stops.push(
        scheduler(
          () => {
            const base = ac.currentTime + Math.random() * 0.1;
            for (let i = 0; i < 6; i++) click(ac, out, base + i * 0.055, 4300 + Math.random() * 300, 0.02, 0.02);
          },
          640,
        ),
      );
      break;
    }
    case 'tick': {
      // Часы: тик-так раз в секунду, две высоты.
      let n = 0;
      let next = ac.currentTime + 0.1;
      stops.push(
        scheduler(
          () => {
            while (next < ac.currentTime + 1.2) {
              click(ac, out, next, n % 2 ? 1500 : 1900, 0.06, 0.02);
              next += 1;
              n++;
            }
          },
          500,
        ),
      );
      break;
    }
    case 'metronome': {
      // 60 ударов в минуту, каждый четвёртый — акцент.
      let n = 0;
      let next = ac.currentTime + 0.1;
      stops.push(
        scheduler(
          () => {
            while (next < ac.currentTime + 1.2) {
              click(ac, out, next, n % 4 === 0 ? 1200 : 900, n % 4 === 0 ? 0.12 : 0.07, 0.03);
              next += 1;
              n++;
            }
          },
          500,
        ),
      );
      break;
    }
    case 'none':
      break;
  }
  return {
    stop: () => {
      stops.forEach((s) => s());
      master?.disconnect();
      master = null;
    },
  };
}
