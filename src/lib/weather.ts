// Погода через Open-Meteo (бесплатно, без ключа, CORS ок). Координаты — из
// геолокации устройства, при отказе/недоступности — Москва. Кэш 30 мин в
// localStorage, чтобы не дёргать сеть и не переспрашивать координаты.

import { t } from './i18n';

const MOSCOW = { lat: 55.75, lon: 37.62 };
const CACHE_KEY = 'life-hub-weather';
const COORDS_KEY = 'life-hub-weather-coords';
const TTL_MS = 30 * 60 * 1000;

export interface Weather {
  tempC: number;
  feelsC: number;
  maxC: number;
  minC: number;
  code: number; // WMO weather code
  isDay: boolean;
  fetchedAt: number;
}

/** Координаты с точностью ~11 км (один знак). Погоде этого хватает, а точные
 *  до метров координаты у сторонней службы — это адрес дома и работы по
 *  часам. Округляются и сохранённые прежними версиями. */
function coarse(c: { lat: number; lon: number }): { lat: number; lon: number } {
  return { lat: Math.round(c.lat * 10) / 10, lon: Math.round(c.lon * 10) / 10 };
}

function readSavedCoords(): { lat: number; lon: number } | null {
  try {
    const raw = localStorage.getItem(COORDS_KEY);
    return raw ? coarse(JSON.parse(raw) as { lat: number; lon: number }) : null;
  } catch {
    return null;
  }
}

/** Координаты для погоды — БЕЗ единого системного диалога по нашей инициативе.
 *
 *  getCurrentPosition сам по себе показывает запрос «разрешить геопозицию?»,
 *  а iOS вебу разрешения «навсегда» не даёт — и виджет переспрашивал при
 *  каждом протухании кэша, раз в полчаса, бесконечно. Теперь позиционирование
 *  зовётся только когда разрешение УЖЕ выдано (navigator.permissions), иначе
 *  тихо берём последние известные координаты, а без них — Москву. Виджет
 *  погоды — фон, а не причина дёргать человека системными окнами. */
async function getCoords(): Promise<{ lat: number; lon: number }> {
  const saved = readSavedCoords();
  if (!navigator.geolocation) return saved ?? MOSCOW;
  let state = 'prompt';
  try {
    state = (await navigator.permissions.query({ name: 'geolocation' })).state;
  } catch {
    // permissions API нет (старые WebKit) — считаем «не выдано» и не спрашиваем.
  }
  // Запрет, выставленный человеком, — и последние координаты больше не уходят.
  if (state === 'denied') {
    try {
      localStorage.removeItem(COORDS_KEY);
    } catch {
      /* приватный режим */
    }
    return MOSCOW;
  }
  if (state !== 'granted') return saved ?? MOSCOW;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const c = coarse({ lat: p.coords.latitude, lon: p.coords.longitude });
        try {
          localStorage.setItem(COORDS_KEY, JSON.stringify(c));
        } catch {
          /* приватный режим */
        }
        resolve(c);
      },
      () => resolve(saved ?? MOSCOW),
      { timeout: 6000, maximumAge: TTL_MS },
    );
  });
}

function readCache(): Weather | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Weather) : null;
  } catch {
    return null; // приватный режим / битый кэш
  }
}

/** Текущая погода (с кэшем). null — сеть/данные недоступны.
 *  Если сеть пропала, а кэш устарел — возвращаем устаревший кэш:
 *  вчерашняя температура полезнее внезапно исчезнувшего виджета. */
export async function getWeather(): Promise<Weather | null> {
  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  try {
    const { lat, lon } = await getCoords();
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code,is_day,apparent_temperature` +
      `&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
    // Таймаут: без него на «мёртвой» сети запрос висит бесконечно, а виджет
    // остаётся серым скелетоном навсегда. 7 с — и отдаём кэш (или прячемся).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    let r: Response;
    try {
      r = await fetch(url, { signal: ctrl.signal, referrerPolicy: 'no-referrer' });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return cached;
    const d = await r.json();
    const w: Weather = {
      tempC: Math.round(d.current.temperature_2m),
      feelsC: Math.round(d.current.apparent_temperature),
      maxC: Math.round(d.daily.temperature_2m_max[0]),
      minC: Math.round(d.daily.temperature_2m_min[0]),
      code: d.current.weather_code,
      isDay: d.current.is_day === 1,
      fetchedAt: Date.now(),
    };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(w));
    } catch {
      /* приватный режим */
    }
    return w;
  } catch {
    return cached;
  }
}

/** Краткое описание погоды по WMO-коду (для подписи). */
export function weatherLabel(code: number): string {
  if (code === 0) return t('Ясно');
  if (code <= 2) return t('Малооблачно');
  if (code === 3) return t('Облачно');
  if (code <= 48) return t('Туман');
  if (code <= 57) return t('Морось');
  if (code <= 67) return t('Дождь');
  if (code <= 77) return t('Снег');
  if (code <= 82) return t('Ливень');
  if (code <= 86) return t('Снегопад');
  return t('Гроза');
}
