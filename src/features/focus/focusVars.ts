import type { CSSProperties } from 'react';

// Перекрытие акцента приложения тёплой гаммой Focus To-Do — только в пределах
// экрана «Фокус»: кнопка, чипы, иконки и метка фазы наследуют его автоматически.
export const FOCUS_VARS = {
  '--app-accent': 'var(--focus-accent)',
  '--app-accent-2': 'var(--focus-accent-2)',
  // Заливки перекрываем отдельно: они живут в своих токенах, и без этой пары
  // кнопка «Фокуса» брала бы общий синий вместо тёплого — весь смысл
  // перекрытия пропадает.
  '--app-accent-fill': 'var(--focus-accent-fill)',
  '--app-accent-2-fill': 'var(--focus-accent-2-fill)',
  '--shadow-accent': 'var(--shadow-focus)',
} as unknown as CSSProperties;
