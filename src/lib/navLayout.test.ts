import { describe, expect, it } from 'vitest';
import { computeNavLayout, type NavRegistryItem } from './navLayout';
import type { SectionId } from './sections';

const REG: NavRegistryItem[] = [
  { id: 'today', nonHideable: true },
  { id: 'tasks' },
  { id: 'notes' },
  { id: 'goals' },
  { id: 'finance' },
  { id: 'cycle' },
  { id: 'settings', nonHideable: true },
  { id: 'home', anchor: true },
];

const OPTS = {
  maxBottom: 4,
  defaultBottom: ['today', 'tasks', 'notes', 'goals'] as SectionId[],
  anchorId: 'home' as SectionId,
};

describe('computeNavLayout', () => {
  it('без конфига собирает панель по умолчанию с якорем в конце', () => {
    const l = computeNavLayout(REG, undefined, OPTS);
    // Якорь ПОСЛЕДНИМ: «Ещё» замыкает панель (редизайн 15.11.2026).
    expect(l.bottom).toEqual(['today', 'tasks', 'notes', 'goals', 'home']);
    expect(l.more).toContain('finance');
  });

  it('не пускает в панель больше лимита', () => {
    const l = computeNavLayout(REG, { bottom: ['today', 'tasks', 'notes', 'goals', 'finance'] }, OPTS);
    expect(l.bottom).toHaveLength(5); // якорь + 4
    expect(l.bottom).not.toContain('finance');
  });

  it('нормализует битый конфиг: несуществующие id, дубли, якорь в панели', () => {
    const l = computeNavLayout(
      REG,
      { bottom: ['today', 'today', 'nope', 'home', 'tasks'], hidden: ['nope', 'home', 'today'] },
      OPTS,
    );
    expect(l.bottom).toEqual(['today', 'tasks', 'home']);
    // Якорь и нескрываемый раздел спрятать нельзя, несуществующий id отброшен.
    expect(l.hidden).not.toContain('home');
    expect(l.hidden).not.toContain('today');
    expect(l.hidden).not.toContain('nope');
  });

  it('скрытый раздел не попадает ни в панель, ни в «Главную»', () => {
    const l = computeNavLayout(REG, { bottom: ['today', 'finance'], hidden: ['finance'] }, OPTS);
    expect(l.bottom).not.toContain('finance');
    expect(l.more).not.toContain('finance');
    expect(l.hidden).toContain('finance');
  });

  it('новый раздел из реестра падает в хвост «Главной»', () => {
    const l = computeNavLayout(REG, { bottom: ['today'], more: ['goals'] }, OPTS);
    expect(l.more[0]).toBe('goals');
    expect(l.more).toContain('finance');
  });

  it('новинка (featured) первая на «Главной», пока её не расставляли; расставили — на своём месте', () => {
    const reg = [...REG, { id: 'ai' as const, featured: true }];
    expect(computeNavLayout(reg, { bottom: ['today'], more: ['goals'] }, OPTS).more[0]).toBe('ai');
    expect(computeNavLayout(reg, undefined, OPTS).more[0]).toBe('ai');
    expect(computeNavLayout(reg, { bottom: ['today'], more: ['goals', 'ai'] }, OPTS).more.slice(0, 2)).toEqual(['goals', 'ai']);
    expect(computeNavLayout(reg, { bottom: ['today'], hidden: ['ai'] }, OPTS).more).not.toContain('ai');
  });
});
