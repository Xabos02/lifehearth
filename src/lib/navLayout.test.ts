import { describe, expect, it } from 'vitest';
import { computeNavLayout, type NavRegistryItem } from './navLayout';
import type { SectionId } from './sections';

const REG: NavRegistryItem[] = [
  { id: 'today', nonHideable: true },
  { id: 'tasks' },
  { id: 'notes' },
  { id: 'goals' },
  { id: 'finance' },
  { id: 'cycle', hiddenByDefault: true },
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
});

describe('разделы «по запросу» (hiddenByDefault)', () => {
  it('скрыт, когда конфига нет вообще', () => {
    const l = computeNavLayout(REG, undefined, OPTS);
    expect(l.hidden).toContain('cycle');
    expect(l.more).not.toContain('cycle');
    expect(l.bottom).not.toContain('cycle');
  });

  it('скрыт, когда конфиг есть, но раздел в нём не упомянут', () => {
    const l = computeNavLayout(REG, { bottom: ['today', 'tasks'], more: ['goals'] }, OPTS);
    expect(l.hidden).toContain('cycle');
  });

  it('показывается, как только человек положил его в «Главную»', () => {
    const l = computeNavLayout(REG, { bottom: ['today'], more: ['cycle', 'goals'] }, OPTS);
    expect(l.more[0]).toBe('cycle');
    expect(l.hidden).not.toContain('cycle');
  });

  it('показывается, если человек вынес его в панель', () => {
    const l = computeNavLayout(REG, { bottom: ['today', 'cycle'] }, OPTS);
    expect(l.bottom).toContain('cycle');
    expect(l.hidden).not.toContain('cycle');
  });

  it('остаётся скрытым, если человек спрятал его сам — и это не то же самое, что «не видел»', () => {
    // Важный случай: раздел упомянут в hidden явно. Если бы флаг проверял
    // «нет в hidden», такой раздел вёл бы себя как никогда не виденный, и
    // любая перестройка конфига возвращала бы его на экран.
    const l = computeNavLayout(REG, { bottom: ['today'], hidden: ['cycle'] }, OPTS);
    expect(l.hidden).toContain('cycle');
    expect(l.hidden.filter((id) => id === 'cycle')).toHaveLength(1);
  });

  it('не влияет на остальные разделы', () => {
    const l = computeNavLayout(REG, undefined, OPTS);
    expect(l.hidden).toEqual(['cycle']);
  });
});
