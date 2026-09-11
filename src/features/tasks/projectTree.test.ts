import { describe, expect, it } from 'vitest';
import { depthOf, descendantsOf, heightOf, nestRefusal, parentCandidates } from './projectTree';

// Дерево: A → B → C (три уровня), D отдельно, E → F.
const tree = [
  { id: 'A', parentId: null },
  { id: 'B', parentId: 'A' },
  { id: 'C', parentId: 'B' },
  { id: 'D', parentId: null },
  { id: 'E', parentId: null },
  { id: 'F', parentId: 'E' },
];

describe('глубина и высота', () => {
  it('глубина считается от верха', () => {
    expect(depthOf(tree, 'A')).toBe(1);
    expect(depthOf(tree, 'B')).toBe(2);
    expect(depthOf(tree, 'C')).toBe(3);
  });
  it('высота — от проекта вниз', () => {
    expect(heightOf(tree, 'A')).toBe(3);
    expect(heightOf(tree, 'B')).toBe(2);
    expect(heightOf(tree, 'C')).toBe(1);
    expect(heightOf(tree, 'D')).toBe(1);
  });
  it('битый родитель считается корнем — как в рендере', () => {
    expect(depthOf([{ id: 'X', parentId: 'ghost' }], 'X')).toBe(1);
  });
  it('кольцо в данных не вешает обход', () => {
    const loop = [{ id: 'P', parentId: 'Q' }, { id: 'Q', parentId: 'P' }];
    expect(depthOf(loop, 'P')).toBeGreaterThan(0);
    expect(heightOf(loop, 'P')).toBeGreaterThan(0);
  });
});

describe('потомки', () => {
  it('дети и внуки, без самого проекта', () => {
    expect([...descendantsOf(tree, 'A')].sort()).toEqual(['B', 'C']);
    expect(descendantsOf(tree, 'D').size).toBe(0);
  });
});

describe('можно ли вложить', () => {
  it('в самого себя — нет', () => {
    expect(nestRefusal(tree, 'A', 'A')).toBe('self');
  });
  it('в собственного потомка — нет: это кольцо', () => {
    expect(nestRefusal(tree, 'A', 'C')).toBe('cycle');
    expect(nestRefusal(tree, 'E', 'F')).toBe('cycle');
  });
  it('проект с подпроектами внутрь другого — можно, пока влезает в три уровня', () => {
    // E → F (высота 2) внутрь D (глубина 1): итог 3 — можно.
    expect(nestRefusal(tree, 'E', 'D')).toBeNull();
    // A → B → C (высота 3) внутрь D: итог 4 — нет.
    expect(nestRefusal(tree, 'A', 'D')).toBe('depth');
    // E → F внутрь B (глубина 2): итог 4 — нет.
    expect(nestRefusal(tree, 'E', 'B')).toBe('depth');
  });
  it('лист можно вложить на любой уровень до третьего', () => {
    expect(nestRefusal(tree, 'D', 'B')).toBeNull(); // станет третьим
    expect(nestRefusal(tree, 'D', 'C')).toBe('depth'); // стал бы четвёртым
  });
});

describe('кандидаты в родители для формы', () => {
  it('для нового проекта — все, кроме третьего уровня', () => {
    expect(parentCandidates(tree, null).map((p) => p.id).sort()).toEqual(['A', 'B', 'D', 'E', 'F']);
  });
  it('для проекта с подпроектами — только те, куда влезет поддерево', () => {
    expect(parentCandidates(tree, 'E').map((p) => p.id).sort()).toEqual(['A', 'D']);
  });
  it('для проекта на три уровня — никто', () => {
    expect(parentCandidates(tree, 'A')).toEqual([]);
  });
});
