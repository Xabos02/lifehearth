import { afterEach, describe, expect, it, vi } from 'vitest';

// Погода — единственный путь координат наружу (Open-Meteo, третья сторона).
// Точные до метров координаты по часам — адрес дома и работы; уходит только
// ~11 км, а после запрета геопозиции — ничего своего.

function env(state: string, saved: object | null) {
  const store = new Map<string, string>(saved ? [['life-hub-weather-coords', JSON.stringify(saved)]] : []);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('navigator', {
    permissions: { query: async () => ({ state }) },
    geolocation: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 55.751234, longitude: 37.618456 } }) },
  });
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (u: string) => {
    urls.push(u);
    return new Response('{}', { status: 500 });
  });
  return { store, urls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('координаты для погоды', () => {
  it('уходят и сохраняются с точностью до десятых', async () => {
    const { store, urls } = env('granted', null);
    await (await import('./weather')).getWeather();
    expect(urls[0]).toContain('latitude=55.8&longitude=37.6&');
    expect(JSON.parse(store.get('life-hub-weather-coords')!)).toEqual({ lat: 55.8, lon: 37.6 });
  });

  it('точные, сохранённые прежней версией, тоже уходят округлёнными', async () => {
    const { urls } = env('prompt', { lat: 59.938678, lon: 30.314997 });
    await (await import('./weather')).getWeather();
    expect(urls[0]).toContain('latitude=59.9&longitude=30.3&');
  });

  it('после запрета геопозиции сохранённые стираются и уходит Москва', async () => {
    const { store, urls } = env('denied', { lat: 59.9, lon: 30.3 });
    await (await import('./weather')).getWeather();
    expect(urls[0]).toContain('latitude=55.75&longitude=37.62&');
    expect(store.has('life-hub-weather-coords')).toBe(false);
  });
});
