// Рингтон входящего звонка: синтез через WebAudio (без аудиофайлов).
// Несколько вариантов на выбор (settings.callSound); паттерн — трель/пауза.
// Autoplay-политика может держать контекст suspended, пока не было жеста —
// resume() пробуем на старте и при первом же касании экрана (оверлей звонка
// всё равно уже виден, так что звонок не теряется, просто без звука).
// На Android дополнительно вибрация — но Chromium блокирует vibrate() без
// жеста в сессии (холодный запуск из пуша = только звук); iOS игнорирует всегда.

import { db } from '../../db/db';

export type RingtoneKind = 'classic' | 'soft' | 'bright';

export const RINGTONES: { value: RingtoneKind; label: string }[] = [
  { value: 'classic', label: 'Классический' },
  { value: 'soft', label: 'Мягкий' },
  { value: 'bright', label: 'Яркий' },
];

// Частоты трели, длительность одного «звонка» и период цикла (звук + пауза).
const RING_PARAMS: Record<RingtoneKind, { freqs: number[]; burst: number; cycle: number }> = {
  classic: { freqs: [440, 480], burst: 2, cycle: 4 }, // классическая телефонная трель
  soft: { freqs: [523.25, 659.25], burst: 1.4, cycle: 3.2 }, // мягкая мажорная терция C5+E5
  bright: { freqs: [880, 1108.73], burst: 0.5, cycle: 1.3 }, // яркие частые сигналы A5+C#6
};

let ctx: AudioContext | null = null;
let stopCurrent: (() => void) | null = null;
let armed = false;
// Токен старта: отменяет ещё не начавшийся асинхронный старт, если между
// чтением настроек и запуском успели вызвать stop (или новый start).
let startToken = 0;

/** Разлочить WebAudio заранее, первым же жестом в сессии (iOS требует жест на
 *  странице; тап по пуш-уведомлению жестом НЕ считается). Тогда к моменту
 *  входящего звонка контекст уже running и рингтон звучит сразу. */
export function armRingtoneUnlock(): void {
  if (armed) return;
  armed = true;
  const unlock = () => {
    try {
      ctx = ctx ?? new AudioContext();
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      if (ctx.state === 'running') window.removeEventListener('pointerdown', unlock);
    } catch {
      /* WebAudio недоступен */
    }
  };
  window.addEventListener('pointerdown', unlock);
}

function burst(ac: AudioContext, at: number, dur: number, dest: GainNode, freqs: number[]) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(1, at + 0.02);
  g.gain.setValueAtTime(1, at + dur - 0.04);
  g.gain.linearRampToValueAtTime(0, at + dur);
  g.connect(dest);
  const oscs = freqs.map((f) => {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(g);
    o.start(at);
    o.stop(at + dur);
    return o;
  });
  return () => {
    for (const o of oscs) {
      try {
        o.stop();
      } catch {
        /* уже остановлен */
      }
    }
  };
}

function beginRingtone(kind: RingtoneKind): void {
  const { freqs, burst: burstDur, cycle } = RING_PARAMS[kind] ?? RING_PARAMS.classic;
  try {
    ctx = ctx ?? new AudioContext();
  } catch {
    return; // WebAudio недоступен — оверлей всё равно покажется
  }
  const ac = ctx;
  const master = ac.createGain();
  master.gain.value = 0.4;
  master.connect(ac.destination);

  let cancels: (() => void)[] = [];
  const scheduleCycle = () => {
    // Вибрация длиной с трель (а не фикс. паттерн) — иначе у короткого «Яркого»
    // цикла паттерн длиннее периода и вибро «слипается» в непрерывное.
    if (typeof navigator.vibrate === 'function') navigator.vibrate(Math.round(burstDur * 1000));
    // У suspended контекста currentTime заморожен: запланированные трели легли
    // бы стопкой на одну и ту же отметку и при разлочке грянули бы все разом
    // клиппованным залпом. Пока не running — просто пропускаем тик.
    if (ac.state !== 'running') return;
    const at = ac.currentTime + 0.05;
    cancels.push(burst(ac, at, burstDur, master, freqs));
  };

  const tryResume = () => {
    if (ac.state === 'suspended') void ac.resume().catch(() => {});
  };
  tryResume();
  scheduleCycle();
  const timer = setInterval(scheduleCycle, cycle * 1000);
  // Если autoplay заблокировал звук — первый же тап (по любому месту, включая
  // кнопки оверлея) резюмирует контекст, и следующая трель уже прозвучит.
  window.addEventListener('pointerdown', tryResume);

  stopCurrent = () => {
    clearInterval(timer);
    window.removeEventListener('pointerdown', tryResume);
    for (const c of cancels) c();
    cancels = [];
    try {
      master.disconnect();
    } catch {
      /* контекст уже закрыт */
    }
    if (typeof navigator.vibrate === 'function') navigator.vibrate(0);
  };
}

/** Запустить рингтон выбранного в настройках вида (по умолчанию «Классический»). */
export function startRingtone(): void {
  stopRingtone();
  const token = ++startToken;
  void db.settings.get('app').then((s) => {
    if (token !== startToken) return; // за время чтения настроек вызвали stop/новый start
    beginRingtone((s?.callSound as RingtoneKind | undefined) ?? 'classic');
  });
}

export function stopRingtone(): void {
  startToken++; // отменяет ещё не начавшийся асинхронный старт
  if (stopCurrent) {
    stopCurrent();
    stopCurrent = null;
  }
}

// Гудки звонящему — «контроль посылки вызова» телефонной сети: 425 Гц, 1 с
// звук, 4 с пауза (приказ Мининформсвязи № 48 от 2007, прил. 7; тот же ритм в
// ГОСТ 28384-89 и у ETSI). Раньше «Вызов…» шёл в тишине, и звонящий не
// понимал, идёт ли вызов вообще.
const RINGBACK_HZ = 425;
const RINGBACK_ON_S = 1;
const RINGBACK_CYCLE_S = 5;
// Весь дозвон (45 с) с запасом. Расписание кладём на часы аудиоконтекста
// разом, а не тикаем таймером: iOS притормаживает таймеры, и гудки поплыли
// бы. У приостановленного контекста часы стоят — расписание просто сдвинется
// целиком и зазвучит с разлочки, без залпа.
const RINGBACK_CYCLES = 12;

let stopBack: (() => void) | null = null;

/** Гудки, пока у собеседника звонит. Останавливает stopRingback. */
export function startRingback(): void {
  stopRingback();
  let ac: AudioContext;
  try {
    ctx = ctx ?? new AudioContext();
    ac = ctx;
  } catch {
    return; // WebAudio недоступен — «Вызов…» на экране остаётся
  }
  // iOS держит контекст 'interrupted' после захвата микрофона — будим.
  if (ac.state !== 'running') void ac.resume().catch(() => {});
  const master = ac.createGain();
  master.gain.value = 0.3; // ≈ −10 дБ: середина допуска сигнала (−15…−5 дБ)
  master.connect(ac.destination);
  const t0 = ac.currentTime + 0.05;
  const cancels: (() => void)[] = [];
  for (let i = 0; i < RINGBACK_CYCLES; i++) {
    cancels.push(burst(ac, t0 + i * RINGBACK_CYCLE_S, RINGBACK_ON_S, master, [RINGBACK_HZ]));
  }
  stopBack = () => {
    for (const c of cancels) c();
    try {
      master.disconnect();
    } catch {
      /* контекст уже закрыт */
    }
  };
}

export function stopRingback(): void {
  if (stopBack) {
    stopBack();
    stopBack = null;
  }
}

/** Короткое прослушивание варианта (для настроек): одна трель, затем стоп.
 *  Останавливаем только СВОЙ предпрослушиваемый рингтон: если за 2.2 с придёт
 *  реальный входящий (сменит startToken), его трель мы не глушим. */
export function previewRingtone(kind: RingtoneKind): void {
  stopRingtone();
  const token = startToken;
  beginRingtone(kind);
  setTimeout(() => {
    if (startToken === token) stopRingtone();
  }, 2200);
}
