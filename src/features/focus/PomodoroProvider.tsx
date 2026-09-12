import { useMemo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { todayKey } from '../../lib/dates';
import { schedulePush, cancelPush } from '../../lib/push';
import { TimeCtx, Ctx, type Phase, type PomodoroCtx, type SoundType } from './pomodoro';
import { t } from '../../lib/i18n';

// Помодоро-таймер на основе timestamp (endsAt) — корректно показывает остаток
// после сворачивания приложения и навигации. Состояние глобальное (контекст),
// чтобы мини-таймер был виден из любого раздела. Звук — Web Audio (без файлов):
// сигнал смены фазы + фоновый шум (белый/розовый/коричневый/«дождь») во время работы.

export type { Phase, SoundType } from './pomodoro';

const LONG_AFTER = 4; // длинный перерыв после стольких рабочих сессий
const LONG_MIN = 15;

interface Persisted {
  phase: Phase;
  running: boolean;
  endsAt: number | null; // когда running
  remainingMs: number; // когда на паузе
  taskId: string | null;
  taskTitle: string | null;
  workCount: number;
  completedToday: number;
  focusMinToday: number; // суммарно минут фокуса за сегодня
  date: string;
  workMin: number;
  breakMin: number;
  longMin: number;
  sound: SoundType;
}


const STORE_KEY = 'life-hub-pomodoro';

function phaseMs(phase: Phase, workMin: number, breakMin: number, longMin: number): number {
  if (phase === 'work') return workMin * 60_000;
  if (phase === 'long') return longMin * 60_000;
  return breakMin * 60_000;
}

// ── Уведомления о конце круга ─────────────────────────────────────────────────
//
// Ключ напоминания — свой на каждом устройстве, а не общий 'pomodoro-end'.
//
// На сервере это первичный ключ таблицы напоминаний, запись идёт через
// INSERT OR REPLACE. С общим ключом семья делила одно напоминание на всех:
// Влад запустил фокус, через минуту жена на своём телефоне — её строка
// заменила его, и «Фокус завершён» пришёл только ей. Пауза или сброс у
// любого слали /cancel с тем же ключом и снимали напоминание у обоих.
// У задач такого нет — там ключ это id задачи. Найдено разбором 11.09.2026,
// по коду; живым прогоном не воспроизводилось, но механизм однозначный.
const POMO_PUSH_ID = `pomodoro-end:${deviceTag()}`;

/** Метка устройства для ключей, которые должны быть свои на каждом.
 *  Один раз генерируется и живёт в localStorage; в синк и бэкап не уезжает —
 *  в этом весь смысл. */
function deviceTag(): string {
  const KEY = 'life-hub-device';
  try {
    const have = localStorage.getItem(KEY);
    if (have) return have;
    const fresh = crypto.randomUUID();
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return 'local';
  }
}

/** Текст уведомления по фазе, которая заканчивается. */
function phaseEndText(phase: Phase): { title: string; body: string } {
  return phase === 'work'
    ? { title: t('🍅 Фокус завершён'), body: t('Время для перерыва') }
    : { title: t('Перерыв окончен'), body: t('Возвращайтесь к фокусу') };
}

/** Локальное системное уведомление о конце фазы (когда приложение активно). */
function notifyPhaseEnd(endedPhase: Phase): void {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const { title, body } = phaseEndText(endedPhase);
    const opts: NotificationOptions = {
      body,
      tag: POMO_PUSH_ID,
      icon: '/life-hub/icons/icon-192.png',
      badge: '/life-hub/icons/icon-192.png',
    };
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, opts)).catch(() => {});
    } else {
      new Notification(title, opts);
    }
  } catch {
    /* нет SW/уведомлений */
  }
}

/** Фоновый пуш на конец текущей фазы через Worker (на случай свёрнутого PWA). */
function syncPhasePush(s: Persisted): void {
  if (s.running && s.endsAt) {
    const { title, body } = phaseEndText(s.phase);
    void schedulePush(POMO_PUSH_ID, s.endsAt, title, body);
  } else {
    void cancelPush(POMO_PUSH_ID);
  }
}

/** Разовый запрос разрешения на уведомления — по жесту старта. */
function ensureNotifyPermission(): void {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  } catch {
    /* ignore */
  }
}

function load(): Persisted {
  const base: Persisted = {
    phase: 'work',
    running: false,
    endsAt: null,
    remainingMs: 25 * 60_000,
    taskId: null,
    taskTitle: null,
    workCount: 0,
    completedToday: 0,
    focusMinToday: 0,
    date: todayKey(),
    workMin: 25,
    breakMin: 5,
    longMin: LONG_MIN,
    sound: 'none',
  };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const p = { ...base, ...(JSON.parse(raw) as Persisted) };
    if (p.date !== todayKey()) {
      p.completedToday = 0; // счётчики — за сегодня
      p.focusMinToday = 0;
    }
    return p;
  } catch {
    return base;
  }
}

// ── Аудио ───────────────────────────────────────────────────────────────────
let audioCtx: AudioContext | null = null;
function ensureAudio(): AudioContext | null {
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

function beep() {
  const ac = ensureAudio();
  if (ac) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g);
    g.connect(ac.destination);
    o.type = 'sine';
    o.frequency.value = 880;
    const t = ac.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    o.start(t);
    o.stop(t + 0.6);
  }
  navigator.vibrate?.(200);
}

function makeNoiseBuffer(ac: AudioContext, kind: SoundType): AudioBuffer {
  const len = ac.sampleRate * 2;
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  if (kind === 'brown') {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  } else if (kind === 'pink') {
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
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; // white / база для rain
  }
  return buf;
}

let noiseSrc: AudioBufferSourceNode | null = null;
function stopNoise() {
  try {
    noiseSrc?.stop();
  } catch {
    /* уже остановлен */
  }
  noiseSrc = null;
}
function startNoise(kind: SoundType) {
  stopNoise();
  if (kind === 'none') return;
  const ac = ensureAudio();
  if (!ac) return;
  const src = ac.createBufferSource();
  src.buffer = makeNoiseBuffer(ac, kind === 'rain' ? 'white' : kind);
  src.loop = true;
  const gain = ac.createGain();
  gain.gain.value = kind === 'brown' ? 0.16 : 0.1;
  if (kind === 'rain' || kind === 'pink' || kind === 'brown') {
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = kind === 'rain' ? 3200 : kind === 'brown' ? 500 : 1400;
    src.connect(lp);
    lp.connect(gain);
  } else {
    src.connect(gain);
  }
  gain.connect(ac.destination);
  src.start();
  noiseSrc = src;
}

export function PomodoroProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<Persisted>(load);
  const sRef = useRef(s);
  sRef.current = s;

  const persist = useCallback((next: Persisted) => {
    const prev = sRef.current;
    sRef.current = next; // синхронно — чтобы следующий persist в том же тике видел свежее
    setS(next);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      /* квота */
    }
    // Переставить/снять фоновый пуш конца фазы только при значимой смене состояния.
    if (prev.running !== next.running || prev.endsAt !== next.endsAt || prev.phase !== next.phase) {
      syncPhasePush(next);
    }
  }, []);

  const total = phaseMs(s.phase, s.workMin, s.breakMin, s.longMin);
  const remainingMs =
    s.running && s.endsAt != null ? Math.max(0, s.endsAt - Date.now()) : s.remainingMs;

  const [, force] = useState(0);
  useEffect(() => {
    if (!s.running) return;
    const id = setInterval(() => {
      const cur = sRef.current;
      if (!cur.running || cur.endsAt == null) return;
      if (cur.endsAt - Date.now() <= 0) advancePhase();
      else force((n) => n + 1);
    }, 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.running, s.endsAt]);

  useEffect(() => {
    const onVis = () => {
      const cur = sRef.current;
      if (cur.running && cur.endsAt != null && cur.endsAt - Date.now() <= 0) advancePhase();
      else force((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Фоновый шум — только во время работающей рабочей фазы.
  useEffect(() => {
    if (s.running && s.phase === 'work' && s.sound !== 'none') startNoise(s.sound);
    else stopNoise();
    return () => stopNoise();
  }, [s.running, s.phase, s.sound]);

  /** Перейти к следующей фазе.
   *
   *  skipped — фазу пропустили рукой, а не досидели. Для рабочей фазы это
   *  меняет учёт: раньше «Старт» и через десять секунд «Пропустить» давали
   *  в статистике +1 помодоро и +25 минут — столько же, сколько честный
   *  круг. Теперь пропущенный круг не засчитывается, а минуты берутся
   *  фактические, сколько реально прошло, с округлением вниз. Разбор
   *  раздела 11.09.2026. */
  function advancePhase(skipped = false) {
    const cur = sRef.current;
    beep();
    notifyPhaseEnd(cur.phase);
    if (cur.phase === 'work') {
      const workCount = cur.workCount + 1;
      const nextPhase: Phase = workCount % LONG_AFTER === 0 ? 'long' : 'break';
      const elapsedMs =
        cur.running && cur.endsAt != null
          ? Math.max(0, cur.workMin * 60_000 - (cur.endsAt - Date.now()))
          : cur.workMin * 60_000 - cur.remainingMs;
      const earnedMin = skipped ? Math.floor(elapsedMs / 60_000) : cur.workMin;
      persist({
        ...cur,
        phase: nextPhase,
        workCount,
        completedToday: cur.completedToday + (skipped ? 0 : 1),
        focusMinToday: cur.focusMinToday + earnedMin,
        date: todayKey(),
        running: true,
        endsAt: Date.now() + phaseMs(nextPhase, cur.workMin, cur.breakMin, cur.longMin),
        remainingMs: phaseMs(nextPhase, cur.workMin, cur.breakMin, cur.longMin),
      });
    } else {
      persist({
        ...cur,
        phase: 'work',
        running: false,
        endsAt: null,
        remainingMs: cur.workMin * 60_000,
      });
    }
  }

  const start: PomodoroCtx['start'] = useCallback(
    (taskId = null, taskTitle = null) => {
      const cur = sRef.current;
      const ms = phaseMs('work', cur.workMin, cur.breakMin, cur.longMin);
      persist({
        ...cur,
        phase: 'work',
        running: true,
        endsAt: Date.now() + ms,
        remainingMs: ms,
        taskId: taskId ?? cur.taskId,
        taskTitle: taskTitle ?? cur.taskTitle,
        date: todayKey(),
      });
      ensureAudio(); // разблокировать аудио жестом пользователя
      ensureNotifyPermission(); // спросить разрешение на уведомления о конце круга
    },
    [persist],
  );

  const toggle = useCallback(() => {
    const cur = sRef.current;
    if (cur.running) {
      persist({
        ...cur,
        running: false,
        endsAt: null,
        remainingMs: Math.max(0, (cur.endsAt ?? Date.now()) - Date.now()),
      });
    } else {
      const rem =
        cur.remainingMs > 0 ? cur.remainingMs : phaseMs(cur.phase, cur.workMin, cur.breakMin, cur.longMin);
      persist({ ...cur, running: true, endsAt: Date.now() + rem, remainingMs: rem });
      ensureAudio();
      ensureNotifyPermission();
    }
  }, [persist]);

  const reset = useCallback(() => {
    const cur = sRef.current;
    persist({
      ...cur,
      phase: 'work',
      running: false,
      endsAt: null,
      remainingMs: cur.workMin * 60_000,
      taskId: null,
      taskTitle: null,
      workCount: 0,
    });
  }, [persist]);

  const skip = useCallback(() => {
    advancePhase(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setDurations = useCallback(
    (workMin: number, breakMin: number) => {
      const cur = sRef.current;
      persist({
        ...cur,
        workMin,
        breakMin,
        remainingMs: cur.running ? cur.remainingMs : workMin * 60_000,
      });
    },
    [persist],
  );

  // Независимые сеттеры: читают sRef.current (всегда свежее), поэтому смена
  // одного поля не затирает другое и не зависит от тайминга ре-рендера.
  const setWorkMin = useCallback(
    (workMin: number) => {
      const cur = sRef.current;
      persist({ ...cur, workMin, remainingMs: cur.running ? cur.remainingMs : workMin * 60_000 });
    },
    [persist],
  );

  const setBreakMin = useCallback(
    (breakMin: number) => {
      persist({ ...sRef.current, breakMin });
    },
    [persist],
  );

  const setLongMin = useCallback(
    (longMin: number) => {
      persist({ ...sRef.current, longMin });
    },
    [persist],
  );

  const setTask = useCallback(
    (taskId: string | null, taskTitle: string | null) => {
      persist({ ...sRef.current, taskId, taskTitle });
    },
    [persist],
  );

  const setSound = useCallback(
    (sound: SoundType) => {
      persist({ ...sRef.current, sound });
      ensureAudio();
    },
    [persist],
  );

  const active = s.running || s.remainingMs < total || s.phase !== 'work';

  // Действия и редкие поля — отдельным значением, в useMemo.
  //
  // Тик таймера идёт дважды в секунду. Пока значение было одно и собиралось
  // заново на каждый рендер, вместе с ним перерисовывался каждый подписчик:
  // форма задачи, кнопка «+», всё поддерево. Владелец видел это как «дёргается
  // экран во время письма продолжительного» — он печатал, а под пальцами
  // дважды в секунду пересобиралась форма.
  //
  // Теперь тикающее время уехало в свой провайдер (ниже), а здесь остаётся то,
  // что меняется по делу: фаза, флаги, настройки, действия.
  const actions = useMemo(
    () => ({
      phase: s.phase,
      running: s.running,
      totalMs: total,
      taskId: s.taskId,
      taskTitle: s.taskTitle,
      completedToday: s.completedToday,
      focusMinToday: s.focusMinToday,
      workMin: s.workMin,
      breakMin: s.breakMin,
      longMin: s.longMin,
      sound: s.sound,
      active,
      start,
      toggle,
      reset,
      skip,
      setDurations,
      setWorkMin,
      setBreakMin,
      setLongMin,
      setTask,
      setSound,
    }),
    [
      s.phase,
      s.running,
      total,
      s.taskId,
      s.taskTitle,
      s.completedToday,
      s.focusMinToday,
      s.workMin,
      s.breakMin,
      s.longMin,
      s.sound,
      active,
      start,
      toggle,
      reset,
      skip,
      setDurations,
      setWorkMin,
      setBreakMin,
      setLongMin,
      setTask,
      setSound,
    ],
  );

  return (
    <Ctx.Provider value={actions}>
      <TimeCtx.Provider value={remainingMs}>{children}</TimeCtx.Provider>
    </Ctx.Provider>
  );
}
