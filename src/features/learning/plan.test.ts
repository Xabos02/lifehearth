import { describe, expect, it } from 'vitest';
import { parsePlan, planToText } from './plan';

// План вводится текстом: список тем почти всегда уже есть готовым — на
// странице курса, в оглавлении книги, в письме от школы. Разбор этого текста
// проверяется прямо, потому что ошибка в нём тихая: часть просто не появится
// или получит чужую оценку, а человек увидит это через месяц по кривому
// проценту.

describe('разбор плана', () => {
  it('пустой текст даёт пустой план', () => {
    expect(parsePlan('')).toEqual([]);
    expect(parsePlan('\n\n   \n')).toEqual([]);
  });

  it('строка — это часть', () => {
    expect(parsePlan('Введение\nГлава 1')).toEqual([
      { section: '', title: 'Введение', estimate: 0 },
      { section: '', title: 'Глава 1', estimate: 0 },
    ]);
  });

  it('решётка открывает раздел и держится до следующей', () => {
    const plan = parsePlan('# Модуль 1\nВведение\n# Модуль 2\nФинансы');
    expect(plan.map((p) => p.section)).toEqual(['Модуль 1', 'Модуль 2']);
    expect(plan.map((p) => p.title)).toEqual(['Введение', 'Финансы']);
  });

  it('число после тире — оценка', () => {
    expect(parsePlan('Введение — 3')[0]).toEqual({ section: '', title: 'Введение', estimate: 3 });
    expect(parsePlan('Введение – 2,5')[0].estimate).toBe(2.5);
    expect(parsePlan('Введение - 1.5')[0].estimate).toBe(1.5);
  });

  it('тире внутри названия не путается с оценкой', () => {
    const [p] = parsePlan('Бизнес-планирование — 4');
    expect(p.title).toBe('Бизнес-планирование');
    expect(p.estimate).toBe(4);
  });

  it('тире без числа остаётся частью названия', () => {
    expect(parsePlan('Кейс — разбор ситуации')[0]).toEqual({
      section: '',
      title: 'Кейс — разбор ситуации',
      estimate: 0,
    });
  });

  it('маркеры списка срезаются', () => {
    expect(parsePlan('- Введение\n• Глава\n* Итог').map((p) => p.title)).toEqual([
      'Введение',
      'Глава',
      'Итог',
    ]);
  });

  it('строка из одного маркера не даёт пустую часть', () => {
    expect(parsePlan('-\n#\n   ')).toEqual([]);
  });
});

describe('план обратно в текст', () => {
  const part = (title: string, section = '', estimate = 0, i = 0) => ({
    id: `p${i}`,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
    itemId: 'x',
    title,
    section,
    estimate,
    doneAt: null,
    sortOrder: i,
  });

  it('переживает круг: текст → план → текст', () => {
    const src = '# Модуль 1\nВведение — 3\nКейс\n\n# Модуль 2\nФинансы — 2';
    const parts = parsePlan(src).map((p, i) => part(p.title, p.section, p.estimate, i));
    expect(planToText(parts)).toBe(src);
  });

  it('план без разделов пишется голым списком', () => {
    expect(planToText([part('Глава 1', '', 0, 0), part('Глава 2', '', 0, 1)])).toBe(
      'Глава 1\nГлава 2',
    );
  });
});
