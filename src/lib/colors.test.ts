import { describe, expect, it } from 'vitest';
import { ON_COLOR_DARK, PRESET_COLORS, isLightColor } from './colors';

// Глиф на заливке цветом палитры — инициал участника, галочка задачи —
// обязан держать 4.5 (CLAUDE.md). Считаем контраст независимо от функции.
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('isLightColor', () => {
  it('глиф, который она выбирает, держит 4.5 на каждом цвете палитры', () => {
    const bad = PRESET_COLORS
      .map((c) => ({ c, r: ratio(isLightColor(c) ? ON_COLOR_DARK : '#ffffff', c) }))
      .filter(({ r }) => r < 4.5)
      .map(({ c, r }) => `${c} ${r.toFixed(2)}`);
    expect(bad).toEqual([]);
  });

  it('короткий hex разворачивается: на #fff — тёмный глиф', () => {
    expect(isLightColor('#fff')).toBe(true);
    expect(isLightColor('#ffffff')).toBe(true);
  });
});
