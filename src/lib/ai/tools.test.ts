// Исполнители инструментов: чтение реальных структур Dexie в компактный JSON.
//
// Важно не «что-то вернулось», а точные свойства: фильтры статуса и окна дат,
// поиск по тексту HTML-заметок, месячная математика финансов — то, на чём
// модель строит ответ. Соврёт инструмент — соврёт и ответ.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

const { db } = await import('../../db/db');
const { runTool, toolsSystemPrompt } = await import('./tools');

const base = { createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', deletedAt: null };
const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  ...base,
  id,
  title,
  notes: '',
  projectId: null,
  goalId: null,
  priority: 0,
  dueDate: null,
  dueTime: null,
  duration: null,
  remindBefore: null,
  completedAt: null,
  checklist: [],
  recurrence: null,
  tags: [],
  sortOrder: 1000,
  ...extra,
});

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('list_tasks', () => {
  it('по умолчанию активные; completed и окно дат фильтруют', async () => {
    await db.tasks.bulkAdd([
      task('a', 'Активная без даты'),
      task('b', 'В окне', { dueDate: '2026-08-20' }),
      task('c', 'Вне окна', { dueDate: '2026-09-05' }),
      task('d', 'Сделана', { completedAt: '2026-08-10T10:00:00.000Z' }),
      task('e', 'Удалена', { deletedAt: '2026-08-10T10:00:00.000Z' }),
    ] as never[]);

    const active = JSON.parse((await runTool('list_tasks', '{}')).text) as { tasks: { title: string }[] };
    expect(active.tasks.map((t) => t.title).sort()).toEqual(['Активная без даты', 'В окне', 'Вне окна']);

    const windowed = JSON.parse(
      (await runTool('list_tasks', '{"from":"2026-08-15","to":"2026-08-31"}')).text,
    ) as { tasks: { title: string }[] };
    // Окно задано — задачи без даты не тащим: «что на этой неделе» ≠ бэклог.
    expect(windowed.tasks.map((t) => t.title)).toEqual(['В окне']);

    const done = JSON.parse((await runTool('list_tasks', '{"status":"completed"}')).text) as {
      tasks: { title: string }[];
    };
    expect(done.tasks.map((t) => t.title)).toEqual(['Сделана']);
  });

  it('автозадачи «Женских дней» модели не отдаются', async () => {
    await db.tasks.bulkAdd([
      task('a', 'Купить хлеб'),
      task('c', 'Скоро начнутся', { origin: 'cycle', originKey: 'period-soon', dueDate: '2026-09-28' }),
    ] as never[]);
    const r = JSON.parse((await runTool('list_tasks', '{"status":"all"}')).text) as { tasks: { title: string }[] };
    expect(r.tasks.map((t) => t.title)).toEqual(['Купить хлеб']);
  });

  it('проект подписывается именем, приоритет — словом', async () => {
    await db.projects.add({ ...base, id: 'p1', name: 'Работа', color: '#fff', emoji: '', sortOrder: 1, archivedAt: null } as never);
    await db.tasks.add(task('a', 'Отчёт', { projectId: 'p1', priority: 3 }) as never);
    const r = JSON.parse((await runTool('list_tasks', '{}')).text) as {
      tasks: { title: string; project?: string; priority?: string }[];
    };
    expect(r.tasks[0]).toMatchObject({ title: 'Отчёт', project: 'Работа', priority: 'high' });
  });
});

describe('заметки', () => {
  beforeEach(async () => {
    await db.notes.bulkAdd([
      {
        ...base,
        id: 'n1',
        title: 'Поставщик RTE',
        content: '<p>Контакт: Иван, отгрузка со склада в Люберцах</p>',
        tags: [],
        pinned: false,
      },
      { ...base, id: 'n2', title: 'Список книг', content: '<p>Прочитать до осени</p>', tags: [], pinned: true },
    ] as never[]);
  });

  it('search_notes ищет по тексту внутри HTML и отдаёт фрагмент', async () => {
    const r = JSON.parse((await runTool('search_notes', '{"query":"люберц"}')).text) as {
      notes: { title: string; snippet: string }[];
    };
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0].title).toBe('Поставщик RTE');
    expect(r.notes[0].snippet).toContain('Люберцах');
  });

  it('read_note находит по части заголовка и отдаёт текст без тегов', async () => {
    const r = JSON.parse((await runTool('read_note', '{"title":"поставщик"}')).text) as {
      title: string;
      text: string;
    };
    expect(r.title).toBe('Поставщик RTE');
    expect(r.text).toBe('Контакт: Иван, отгрузка со склада в Люберцах');
  });
});

describe('list_finance', () => {
  it('месячная сводка: weekly приводится к месяцу, неактивные не считаются', async () => {
    await db.expenseItems.bulkAdd([
      { ...base, id: 'e1', title: 'Аренда', amount: 60000, kind: 'expense', category: 'Жильё', recurrence: 'monthly', dayOfMonth: 5, notes: '', active: true, sortOrder: 1 },
      { ...base, id: 'e2', title: 'Бассейн', amount: 1000, kind: 'expense', category: 'Спорт', recurrence: 'weekly', dayOfMonth: null, notes: '', active: true, sortOrder: 2 },
      { ...base, id: 'e3', title: 'Старая подписка', amount: 500, kind: 'expense', category: '', recurrence: 'monthly', dayOfMonth: null, notes: '', active: false, sortOrder: 3 },
      { ...base, id: 'e4', title: 'Зарплата', amount: 90000, kind: 'income', category: '', recurrence: 'monthly', dayOfMonth: 10, notes: '', active: true, sortOrder: 4 },
    ] as never[]);
    const r = JSON.parse((await runTool('list_finance', '{}')).text) as {
      items: { title: string }[];
      monthlyExpense: number;
      monthlyIncome: number;
    };
    expect(r.items.map((i) => i.title).sort()).toEqual(['Аренда', 'Бассейн', 'Зарплата']);
    // 60000 + 1000×52/12 ≈ 64333
    expect(r.monthlyExpense).toBe(Math.round(60000 + (1000 * 52) / 12));
    expect(r.monthlyIncome).toBe(90000);
  });
});

describe('системная приписка', () => {
  it('не обещает модели «Женские дни» и велит честно сказать, что их нет', () => {
    // Инструмент убран 25.09; приписка, обещающая цикл, толкала модель искать
    // его по заметкам и отвечать «записей нет» при записях в разделе.
    const p = toolsSystemPrompt();
    expect(p).not.toMatch(/женские дни \(цикл\)/i);
    expect(p).toContain('«Женские дни» тебе недоступен');
  });
});

describe('устойчивость', () => {
  it('битые аргументы не роняют вызов — работаем с пустыми', async () => {
    const r = await runTool('list_tasks', '{оборванный json');
    expect(() => JSON.parse(r.text)).not.toThrow();
  });

  it('неизвестный инструмент — ошибка в content, не исключение', async () => {
    const r = await runTool('take_over_the_world', '{}');
    expect(JSON.parse(r.text)).toMatchObject({ error: expect.stringContaining('неизвестный') });
  });
});
