// Одно согласие на всё, что уходит с телефона (задача 34, решение Влада 25.09).
//
// Без согласия всё внешнее выключено, а локальное работает. Внешнего семь
// каналов, и у каждого свои двери наружу: автоматические (раннеры, таймеры,
// возврат в приложение, код до первого рендера) и по нажатию. Спрашивать базу
// в каждой двери нельзя: часть из них синхронна (push.storedSub, инициализатор
// «Фокуса»), часть срабатывает раньше, чем React что-либо нарисовал. Поэтому
// согласие живёт флагом в памяти:
//  — main.tsx ставит его до первого рендера из settings.consentAt;
//  — watchConsent держит его в ладу с базой (вторая вкладка, восстановление,
//    тесты, пишущие в IndexedDB напрямую);
//  — «Принимаю» ставит его сразу, синхронно, в обработчике нажатия. Действие,
//    ради которого открывали окно, продолжается в той же задаче события, пока
//    браузер ещё считает это жестом: без жеста iOS не покажет запрос
//    разрешения на уведомления, а Safari не включит микрофон.
//
// Отказ («Не сейчас», «Не принимать») помнится отдельно — consentAskedAt:
// окно показывается само один раз, дальше только по попытке включить внешнее.
//
// Перечень хостов — здесь и только здесь. consent.test.ts ищет адреса в
// исходниках и краснеет на любом, которого нет ниже, а e2e/consent.spec.ts
// сверяет с ним живые запросы. Каналы — ключи Record: окно согласия обязано
// дать текст каждому (ConsentPage), иначе не соберутся типы.

import { useSyncExternalStore } from 'react';
import { WORKER_URL } from './workerUrl';

export type ConsentChannel = 'sync' | 'push' | 'family' | 'calls' | 'ai' | 'voice' | 'weather';

/** Что человек пытался включить, когда открылось окно. null — окно открыто
 *  само (первый запуск, обновление) или из настроек, перечитать. */
export type ConsentReason = 'sync' | 'backup' | 'push' | 'family' | 'ai' | 'voice';

const WORKER_HOST = new URL(WORKER_URL).host;

/** Хосты, куда приложение ходит само, — по каналам. Пустой список у голоса
 *  честный: адрес распознавания выбирает браузер, страница его не видит. */
export const EGRESS_HOSTS: Record<ConsentChannel, readonly string[]> = {
  sync: [WORKER_HOST],
  push: [WORKER_HOST],
  family: [WORKER_HOST],
  calls: [WORKER_HOST, 'stun.cloudflare.com', 'stun.l.google.com'],
  ai: [WORKER_HOST],
  voice: [],
  weather: ['api.open-meteo.com'],
};

/** Только по нажатию, согласия не требуют — раскрыты в окне строкой «И без
 *  согласия». Загрузка самого приложения (GitHub Pages) — свой origin. */
export const ON_TAP_HOSTS: readonly string[] = ['maps.apple.com'];

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
export const APPLE_MAPS_URL = 'https://maps.apple.com/';
export const STUN_FALLBACK: readonly string[] = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];

// В юнитах (vitest, MODE 'test') согласие дано: они проверяют логику каналов,
// а не окно, и часть из них пересобирает модули (vi.resetModules) — флаг,
// выставленный снаружи, при этом терялся бы. Проверки «без согласия в сеть не
// ходит» снимают его сами (consent.test.ts). В сборке условие — константа
// false, и Vite вырезает его целиком.
let consented = import.meta.env.MODE === 'test';
let open: { reason: ConsentReason | null } | null = null;
let waiters: ((ok: boolean) => void)[] = [];
const subs = new Set<() => void>();

function notify() {
  for (const cb of subs) cb();
}

export function hasConsent(): boolean {
  return consented;
}

export function setConsentFlag(v: boolean): void {
  if (consented === v) return;
  consented = v;
  notify();
}

/** Попытка включить внешнее. Согласие есть — сразу да; нет — открывается
 *  окно, ответ приходит, когда человек нажмёт «Принимаю» или откажется. */
export function askConsent(reason: ConsentReason): Promise<boolean> {
  if (consented) return Promise.resolve(true);
  return new Promise((resolve) => {
    waiters.push(resolve);
    open = { reason };
    notify();
  });
}

/** Перечитать из настроек: то же окно, без причины. */
export function showConsent(): void {
  open = { reason: null };
  notify();
}

/** Ответ из окна. Флаг и ожидающие — синхронно, запись в базу — следом. */
export async function answerConsent(ok: boolean): Promise<void> {
  if (ok) setConsentFlag(true);
  const pending = waiters;
  waiters = [];
  open = null;
  notify();
  for (const w of pending) w(ok);
  const at = new Date().toISOString();
  const { updateSettings } = await import('../hooks/useSettings');
  await updateSettings(ok ? { consentAt: at, consentAskedAt: at } : { consentAskedAt: at });
}

/** Закрыть окно «Понятно» после перечитывания — ответа не было, ничего не пишем. */
export function closeConsent(): void {
  const pending = waiters;
  waiters = [];
  open = null;
  notify();
  for (const w of pending) w(consented);
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/** Согласие для компонентов: перерисовка по «Принимаю» без перезагрузки. */
export function useConsent(): boolean {
  return useSyncExternalStore(subscribe, hasConsent);
}

/** Открыто ли окно по просьбе (askConsent/showConsent) и зачем. */
export function useConsentRequest(): { reason: ConsentReason | null } | null {
  return useSyncExternalStore(subscribe, () => open);
}

/** Флаг следит за базой: согласие, данное во второй вкладке, доходит сюда.
 *
 *  Только в одну сторону. Отзыва согласия нет, а «Принимаю» ставит флаг раньше,
 *  чем запись доедет до базы: любая другая запись в settings в этот миг дала бы
 *  выборку ещё без consentAt и на мгновение выключила бы всё внешнее. */
export async function watchConsent(): Promise<void> {
  const [{ liveQuery }, { db }] = await Promise.all([import('dexie'), import('../db/db')]);
  liveQuery(() => db.settings.get('app')).subscribe({
    next: (s) => {
      if (s?.consentAt) setConsentFlag(true);
    },
    error: () => {},
  });
}
