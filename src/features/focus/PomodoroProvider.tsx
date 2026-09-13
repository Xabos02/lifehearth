import { useMemo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { todayKey } from '../../lib/dates';
import { schedulePush, cancelPush } from '../../lib/push';
import { TimeCtx, Ctx, type Phase, type PomodoroCtx } from './pomodoro';
import { t } from '../../lib/i18n';
import { ensureAudio, playAlarm, type AlarmType } from './alarms';
import { setNoiseVolume, startNoise, stopNoise, type NoiseType } from './noise';
import { STALE_MS, cycleDots, nextAfterWork, phaseMs as phaseMsOf, settle, type PomodoroState } from './pomodoroSettle';

// Помодоро-таймер на основе timestamp (endsAt) — корректно показывает остаток
// после сворачивания приложения и навигации. Состояние глобальное (контекст),
// чтобы мини-таймер был виден из любого раздела. Звук — Web Audio (без файлов):
// сигнал смены фазы + фоновый шум (белый/розовый/коричневый/«дождь») во время работы.

export type { Phase } from './pomodoro';

const LONG_AFTER = 4; // длинный перерыв после стольких рабочих кругов — по умолчанию
const LONG_MIN = 15;

interface Persisted extends PomodoroState {
  taskId: string | null;
  taskTitle: string | null;
  sound: NoiseType;
  /** Мелодии конца фокуса и конца перерыва — разные, как в Focus To-Do:
   *  «работа кончилась» и «отдых кончился» — разные события. */
  alarmWork: AlarmType;
  alarmBreak: AlarmType;
  alarmVolume: number; // 0..1
  noiseVolume: number; // 0..1
  /** Предупредить за пять минут до конца фокуса — уведомлением. */
  preNotify: boolean;
}

/** За сколько до конца круга предупреждать. */
export const PRE_NOTIFY_MS = 5 * 60_000;


const STORE_KEY = 'life-hub-pomodoro';

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

function phaseMs(phase: Phase, workMin: number, breakMin: number, longMin: number): number {
  return phaseMsOf(phase, { workMin, breakMin, longMin });
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

const PRE_PUSH_ID = `${POMO_PUSH_ID}:pre`;

/** Фоновый пуш на конец текущей фазы через Worker (на случай свёрнутого PWA)
 *  и, если включено, предупреждение за пять минут до конца фокуса. */
function syncPhasePush(s: Persisted): void {
  if (s.running && s.endsAt) {
    const { title, body } = phaseEndText(s.phase);
    void schedulePush(POMO_PUSH_ID, s.endsAt, title, body);
    if (s.preNotify && s.phase === 'work' && s.endsAt - Date.now() > PRE_NOTIFY_MS) {
      void schedulePush(PRE_PUSH_ID, s.endsAt - PRE_NOTIFY_MS, t('Ещё 5 минут'), t('Круг скоро закончится'));
    } else {
      void cancelPush(PRE_PUSH_ID);
    }
  } else {
    void cancelPush(POMO_PUSH_ID);
    void cancelPush(PRE_PUSH_ID);
  }
}

/** Локальное уведомление «ещё 5 минут» — когда приложение открыто, а
 *  человек смотрит в другой раздел. Тот же tag, что у пуша: не задваивается. */
function notifyPreEnd(): void {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const opts: NotificationOptions = { body: t('Круг скоро закончится'), tag: PRE_PUSH_ID, icon: '/life-hub/icons/icon-192.png' };
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.ready.then((reg) => reg.showNotification(t('Ещё 5 минут'), opts)).catch(() => {});
    } else new Notification(t('Ещё 5 минут'), opts);
  } catch {
    /* нет уведомлений */
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
    longAfter: LONG_AFTER,
    sound: 'none',
    alarmWork: 'soft',
    alarmBreak: 'soft',
    alarmVolume: 0.8,
    noiseVolume: 0.6,
    preNotify: false,
  };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Persisted & { alarm?: AlarmType };
    // До 1.25 сигнал был один (alarm) — он становится сигналом конца фокуса.
    const stored = { ...base, ...parsed, alarmWork: parsed.alarmWork ?? parsed.alarm ?? base.alarmWork };
    // Фазы, кончившиеся пока приложение было закрыто, докручиваются молча —
    // иначе первый же тик после открытия сыграл бы «Фокус завершён» за вчера.
    const p = settle(stored, Date.now(), todayKey());
    if (p !== stored) {
      localStorage.setItem(STORE_KEY, JSON.stringify(p));
      syncPhasePush(p);
    }
    if (p.date !== todayKey()) {
      p.completedToday = 0; // счётчики — за сегодня
      p.focusMinToday = 0;
      p.workCount = 0; // и цикл кругов: вчерашние три не должны вести в длинный перерыв после одного сегодняшнего
    }
    return p;
  } catch {
    return base;
  }
}

// ── Аудио: сигналы в alarms.ts, шум в noise.ts ──────────────────────────────

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
  // Для какого endsAt предупреждение «ещё 5 минут» уже показано.
  const preFiredFor = useRef<number | null>(null);
  useEffect(() => {
    if (!s.running) return;
    const id = setInterval(() => {
      const cur = sRef.current;
      if (!cur.running || cur.endsAt == null) return;
      const now = Date.now();
      if (cur.endsAt <= now) {
        // Тот же порог, что у возврата из фона: вкладка на компьютере может
        // проспать час с замороженным таймером, не сменив видимость.
        if (now - cur.endsAt < STALE_MS) advancePhase();
        else persist(settle(cur, now, todayKey()));
      } else {
        // «Ещё 5 минут» — один раз на круг, в момент пересечения порога.
        const left = cur.endsAt - now;
        if (cur.preNotify && cur.phase === 'work' && left <= PRE_NOTIFY_MS && preFiredFor.current !== cur.endsAt) {
          preFiredFor.current = cur.endsAt;
          notifyPreEnd();
        }
        force((n) => n + 1);
      }
    }, 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.running, s.endsAt]);

  useEffect(() => {
    const onVis = () => {
      const cur = sRef.current;
      const now = Date.now();
      if (cur.running && cur.endsAt != null && cur.endsAt <= now) {
        // Дошло только что — обычный переход со звуком. Давно — докрутка
        // молча: пуш об этом уже приходил, сигнал сейчас был бы «за вчера».
        if (now - cur.endsAt < STALE_MS) advancePhase();
        else persist(settle(cur, now, todayKey()));
      } else force((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Фоновый шум — только во время работающей рабочей фазы. Выбранный в простое
  // шум звучит пару секунд на пробу: иначе тап по чипу давал тишину, и выбор
  // выглядел сломанным. Пробу запускает только выбор рукой (previewRef), не
  // загрузка сохранённого — иначе приложение шумело бы при каждом открытии.
  const previewRef = useRef<NoiseType | null>(null);
  const noiseVolumeRef = useRef(s.noiseVolume);
  noiseVolumeRef.current = s.noiseVolume;
  useEffect(() => {
    if (s.running && s.phase === 'work' && s.sound !== 'none') {
      startNoise(s.sound, noiseVolumeRef.current);
      return () => stopNoise();
    }
    if (previewRef.current === s.sound && s.sound !== 'none') {
      previewRef.current = null;
      startNoise(s.sound, noiseVolumeRef.current);
      const id = setTimeout(stopNoise, 4000);
      return () => {
        clearTimeout(id);
        stopNoise();
      };
    }
    stopNoise();
    return undefined;
  }, [s.running, s.phase, s.sound]);
  // Громкость шума — на ходу, без перезапуска источника.
  useEffect(() => {
    setNoiseVolume(s.noiseVolume);
  }, [s.noiseVolume]);

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
    playAlarm(cur.phase === 'work' ? cur.alarmWork : cur.alarmBreak, cur.alarmVolume);
    notifyPhaseEnd(cur.phase);
    if (cur.phase === 'work') {
      const workCount = cur.workCount + 1;
      const nextPhase = nextAfterWork(workCount, cur.longAfter);
      const elapsedMs =
        cur.running && cur.endsAt != null
          ? Math.max(0, cur.workMin * 60_000 - (cur.endsAt - Date.now()))
          : cur.workMin * 60_000 - cur.remainingMs;
      const earnedMin = skipped ? Math.floor(elapsedMs / 60_000) : cur.workMin;
      // Круг дошёл до конца уже в новый день — счётчики дня с нуля, как в load().
      const sameDay = cur.date === todayKey();
      persist({
        ...cur,
        phase: nextPhase,
        workCount,
        completedToday: (sameDay ? cur.completedToday : 0) + (skipped ? 0 : 1),
        focusMinToday: (sameDay ? cur.focusMinToday : 0) + earnedMin,
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

  // В простое пропускать нечего: раньше кнопка из ничего запускала перерыв и
  // сдвигала счёт кругов — тот, кто тыкал «а что это», получал идущий перерыв.
  const skip = useCallback(() => {
    const cur = sRef.current;
    const idle = !cur.running && cur.phase === 'work' && cur.remainingMs >= cur.workMin * 60_000;
    if (idle) return;
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
    (sound: NoiseType) => {
      previewRef.current = sound;
      persist({ ...sRef.current, sound });
      ensureAudio();
    },
    [persist],
  );

  const setNoiseVolumeCb = useCallback(
    (noiseVolume: number) => {
      persist({ ...sRef.current, noiseVolume: clamp01(noiseVolume) });
    },
    [persist],
  );

  const setAlarmVolume = useCallback(
    (alarmVolume: number) => {
      persist({ ...sRef.current, alarmVolume: clamp01(alarmVolume) });
    },
    [persist],
  );

  const setPreNotify = useCallback(
    (preNotify: boolean) => {
      persist({ ...sRef.current, preNotify });
      // persist ставит пуши только при смене фазы/времени — здесь меняется
      // само правило, пересобрать надо явно.
      syncPhasePush({ ...sRef.current, preNotify });
      if (preNotify) ensureNotifyPermission();
    },
    [persist],
  );

  /** Послушать мелодию, не выбирая её. */
  const previewAlarm = useCallback((kind: AlarmType) => {
    playAlarm(kind, sRef.current.alarmVolume);
  }, []);

  const setLongAfter = useCallback(
    (longAfter: number) => {
      persist({ ...sRef.current, longAfter: Math.max(1, Math.round(longAfter)) });
    },
    [persist],
  );

  // Выбор сигнала сразу его проигрывает: слушать — единственный способ выбрать.
  const setAlarmWork = useCallback(
    (alarmWork: AlarmType) => {
      persist({ ...sRef.current, alarmWork });
      playAlarm(alarmWork, sRef.current.alarmVolume);
    },
    [persist],
  );
  const setAlarmBreak = useCallback(
    (alarmBreak: AlarmType) => {
      persist({ ...sRef.current, alarmBreak });
      playAlarm(alarmBreak, sRef.current.alarmVolume);
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
      longAfter: s.longAfter,
      cycle: cycleDots(s.phase, s.workCount, s.longAfter),
      sound: s.sound,
      alarmWork: s.alarmWork,
      alarmBreak: s.alarmBreak,
      alarmVolume: s.alarmVolume,
      noiseVolume: s.noiseVolume,
      preNotify: s.preNotify,
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
      setLongAfter,
      setAlarmWork,
      setAlarmBreak,
      setAlarmVolume,
      setNoiseVolume: setNoiseVolumeCb,
      setPreNotify,
      previewAlarm,
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
      s.longAfter,
      s.workCount,
      s.sound,
      s.alarmWork,
      s.alarmBreak,
      s.alarmVolume,
      s.noiseVolume,
      s.preNotify,
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
      setLongAfter,
      setAlarmWork,
      setAlarmBreak,
      setAlarmVolume,
      setNoiseVolumeCb,
      setPreNotify,
      previewAlarm,
    ],
  );

  return (
    <Ctx.Provider value={actions}>
      <TimeCtx.Provider value={remainingMs}>{children}</TimeCtx.Provider>
    </Ctx.Provider>
  );
}
