import { ensureAudio, setAudioSession } from '../focus/alarms';
import { isNoisePlaying } from '../focus/noise';
import { callManager } from '../../lib/family/familyCall';

// Щелчок барабана дат — как у колеса выбора времени в будильнике iOS (просьба
// Влада, задача 38): короткий шорох в полосе ~3,6 кГц и едва слышный тон под
// ним. Синтез Web Audio без файлов, как остальные звуки (PROTOCOL §6.4).

let noise: AudioBuffer | null = null;
let last = 0;

/** Разбудить звук по касанию: без жеста iOS держит AudioContext спящим. */
export function unlockTick(): void {
  ensureAudio();
}

export function playTick(): void {
  const ac = ensureAudio();
  // Спящий контекст копит запланированное и выдаёт залпом после первого
  // касания — без жеста щелчок просто молчит.
  if (!ac || ac.state !== 'running') return;
  const t = ac.currentTime;
  // Быстрый бросок ленты перескакивает несколько дней за кадр: один щелчок
  // на кадр, иначе это гул. 12 мс < кадра 60 Гц — медленный проход не теряет ни одного.
  if (t - last < 0.012) return;
  last = t;
  // Беззвучный режим глушит щелчок, как системные щелчки iOS (решение Влада
  // 22.10). Шум «Фокуса» оставляет сессии playback, сигнал — transient, и
  // обратно их не возвращает: в playback щелчок звучал бы в беззвучном режиме
  // и прерывал музыку. Пока шум не играет и нет звонка — сессия по умолчанию
  // (auto): Web Audio в ней глушится, а голосовые в чате звучат как раньше.
  // Не ambient: та оставалась бы на всю страницу и глушила голосовые. На
  // устройстве не проверено.
  if (!isNoisePlaying() && callManager.getSnapshot().status === 'idle') setAudioSession('auto');

  if (!noise) {
    const len = Math.floor(ac.sampleRate * 0.03);
    noise = ac.createBuffer(1, len, ac.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 6;
  }
  const src = ac.createBufferSource();
  src.buffer = noise;
  const band = ac.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 3600;
  band.Q.value = 0.8;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.45, t + 0.0008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
  src.connect(band);
  band.connect(g);
  g.connect(ac.destination);
  src.start(t);
  src.stop(t + 0.03);

  const o = ac.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(2400, t);
  o.frequency.exponentialRampToValueAtTime(1500, t + 0.01);
  const g2 = ac.createGain();
  g2.gain.setValueAtTime(0.0001, t);
  g2.gain.exponentialRampToValueAtTime(0.08, t + 0.0008);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
  o.connect(g2);
  g2.connect(ac.destination);
  o.start(t);
  o.stop(t + 0.02);
}
