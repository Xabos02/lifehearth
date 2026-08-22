import { describe, expect, it } from 'vitest';
import { AUTO_TASK_TEMPLATES, MAX_ACTIVE_AUTO_TASKS, planAutoTasks } from './autoTasks';
import { DEFAULT_CYCLE_SETTINGS } from './cycleRepo';
import type { CycleSettings } from '../../db/cycleTypes';
import type { Task } from '../../db/types';
import type { CyclePredictionResult } from './predict';

const NOW = '2026-07-25T10:00:00.000Z';
const TODAY = '2026-07-25';

const settings = (over: Partial<CycleSettings> = {}): CycleSettings => ({
  ...DEFAULT_CYCLE_SETTINGS,
  updatedAt: NOW,
  ...over,
  integrations: { ...DEFAULT_CYCLE_SETTINGS.integrations, ...(over.integrations ?? {}) },
});

const withAutoTasks = (over: Partial<CycleSettings> = {}) =>
  settings({
    ...over,
    integrations: {
      ...DEFAULT_CYCLE_SETTINGS.integrations,
      ...(over.integrations ?? {}),
      autoTasks: true,
    },
  });

const prediction = (lo80?: string): CyclePredictionResult => ({
  confidence: lo80 ? 'normal' : 'none',
  ...(lo80 ? { lo80, hi80: '2026-08-20', predictedStart: '2026-08-15' } : {}),
  nCyclesUsed: 6,
  drift: false,
  widenedFilter: false,
  daysPastPrediction: 0,
});

const task = (over: Partial<Task>): Task => ({
  id: 'auto-1',
  title: AUTO_TASK_TEMPLATES.supplies.title,
  notes: '',
  projectId: null,
  goalId: null,
  priority: 0,
  dueDate: '2026-08-06',
  dueTime: null,
  duration: null,
  remindBefore: null,
  completedAt: null,
  checklist: [],
  recurrence: null,
  tags: [],
  sortOrder: 1,
  origin: 'cycle',
  originKey: 'supplies',
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...over,
});

describe('planAutoTasks', () => {
  it('пока связка выключена — не создаёт ничего', () => {
    const p = planAutoTasks({
      settings: settings(),
      prediction: prediction('2026-08-10'),
      existing: [],
      today: TODAY,
    });
    expect(p.create).toEqual([]);
    expect(p.reschedule).toEqual([]);
  });

  it('создаёт «пополнить запасы» за четыре дня до нижней границы прогноза', () => {
    const p = planAutoTasks({
      settings: withAutoTasks(),
      prediction: prediction('2026-08-10'),
      existing: [],
      today: TODAY,
    });
    const supplies = p.create.find((c) => c.originKey === 'supplies');
    expect(supplies?.dueDate).toBe('2026-08-06');
  });

  it('по умолчанию заголовок нейтральный', () => {
    const p = planAutoTasks({
      settings: withAutoTasks(),
      prediction: prediction('2026-08-10'),
      existing: [],
      today: TODAY,
    });
    expect(p.create.find((c) => c.originKey === 'supplies')?.title).toBe('Пополнить запасы');
  });

  it('прямые формулировки — только по явному выбору', () => {
    const p = planAutoTasks({
      settings: withAutoTasks({ neutralNotificationText: false }),
      prediction: prediction('2026-08-10'),
      existing: [],
      today: TODAY,
    });
    expect(p.create.find((c) => c.originKey === 'supplies')?.title).toBe(
      'Купить прокладки или тампоны',
    );
  });

  it('двигает уже созданную задачу, когда прогноз поехал', () => {
    const p = planAutoTasks({
      settings: withAutoTasks(),
      prediction: prediction('2026-08-14'),
      existing: [task({ dueDate: '2026-08-06' })],
      today: TODAY,
    });
    expect(p.create.find((c) => c.originKey === 'supplies')).toBeUndefined();
    expect(p.reschedule).toEqual([{ id: 'auto-1', dueDate: '2026-08-10' }]);
  });

  it('не трогает задачу, к которой человек дописал заметку', () => {
    // Задачу, поставленную приложением, человек дополняет: дописывает, что
    // именно купить, заводит чек-лист, двигает срок под свой график. Раньше
    // всё это не считалось следом правки — и приложение возвращало свою дату,
    // отменяя перенос.
    const p = planAutoTasks({
      settings: withAutoTasks(),
      prediction: prediction('2026-08-14'),
      existing: [task({ dueDate: '2026-08-06', notes: 'взять в «Магните», там дешевле' })],
      today: TODAY,
    });
    expect(p.reschedule).toEqual([]);
  });

  it('не трогает задачу с чек-листом', () => {
    const p = planAutoTasks({
      settings: withAutoTasks(),
      prediction: prediction('2026-08-14'),
      existing: [
        task({ dueDate: '2026-08-06', checklist: [{ id: 'c1', text: 'ночные', done: false }] }),
      ],
      today: TODAY,
    });
    expect(p.reschedule).toEqual([]);
  });

  it('не трогает задачу, привязанную к проекту или цели', () => {
    const p = planAutoTasks({
      settings: withAutoTasks(),
      prediction: prediction('2026-08-14'),
      existing: [task({ dueDate: '2026-08-06', projectId: 'p1' })],
      today: TODAY,
    });
    expect(p.reschedule).toEqual([]);
  });

  it('не трогает задачу, которую человек переименовал', () => {
    const p = planAutoTasks({
      settings: withAutoTasks(),
      prediction: prediction('2026-08-14'),
      existing: [task({ title: 'Заехать в аптеку на Ленина' })],
      today: TODAY,
    });
    expect(p.reschedule).toEqual([]);
    // И не подсовывает вторую вместо неё.
    expect(p.create.find((c) => c.originKey === 'supplies')).toBeUndefined();
  });

  it('не создаёт задачу в прошлом', () => {
    const p = planAutoTasks({
      settings: withAutoTasks(),
      prediction: prediction('2026-07-26'), // минус 4 дня = 22 июля, уже прошло
      existing: [],
      today: TODAY,
    });
    expect(p.create.find((c) => c.originKey === 'supplies')).toBeUndefined();
  });

  it('без прогноза «пополнить запасы» не появляется', () => {
    const p = planAutoTasks({
      settings: withAutoTasks(),
      prediction: prediction(),
      existing: [],
      today: TODAY,
    });
    expect(p.create.find((c) => c.originKey === 'supplies')).toBeUndefined();
  });

  it('уважает выключенные прогнозы', () => {
    const p = planAutoTasks({
      settings: withAutoTasks({ predictionsEnabled: false }),
      prediction: prediction('2026-08-10'),
      existing: [],
      today: TODAY,
    });
    expect(p.create.find((c) => c.originKey === 'supplies')).toBeUndefined();
  });

  it('держит лимит активных задач', () => {
    const p = planAutoTasks({
      settings: withAutoTasks(),
      prediction: prediction('2026-08-10'),
      existing: [
        task({ id: 'a', originKey: 'checkup', title: AUTO_TASK_TEMPLATES.checkup.title }),
        task({ id: 'b', originKey: 'other-future-template', title: 'Что-то ещё' }),
      ],
      today: TODAY,
    });
    expect(p.create.length + MAX_ACTIVE_AUTO_TASKS).toBeLessThanOrEqual(
      MAX_ACTIVE_AUTO_TASKS + 1,
    );
    expect(p.create.length).toBeLessThanOrEqual(1);
  });

  it('первый визит к врачу ставит через месяц, а не на сегодня', () => {
    const p = planAutoTasks({
      settings: withAutoTasks(),
      prediction: prediction(),
      existing: [],
      today: TODAY,
    });
    const checkup = p.create.find((c) => c.originKey === 'checkup');
    expect(checkup?.dueDate).toBe('2026-08-24');
  });

  it('следующий визит — через год после выполненного', () => {
    const p = planAutoTasks({
      settings: withAutoTasks(),
      prediction: prediction(),
      existing: [
        task({
          id: 'c1',
          originKey: 'checkup',
          title: AUTO_TASK_TEMPLATES.checkup.title,
          completedAt: '2026-05-10T12:00:00.000Z',
        }),
      ],
      today: TODAY,
    });
    expect(p.create.find((c) => c.originKey === 'checkup')?.dueDate).toBe('2027-05-10');
  });

  it('после выключения связки убирает только нетронутые невыполненные', () => {
    const p = planAutoTasks({
      settings: settings(),
      prediction: prediction('2026-08-10'),
      existing: [
        task({ id: 'clean' }),
        task({ id: 'renamed', title: 'Аптека' }),
        task({ id: 'done', completedAt: '2026-07-01T10:00:00.000Z' }),
      ],
      today: TODAY,
    });
    expect(p.remove).toEqual(['clean']);
  });

  it('не трогает задачи, созданные человеком', () => {
    const p = planAutoTasks({
      settings: settings(),
      prediction: prediction('2026-08-10'),
      existing: [task({ id: 'mine', origin: undefined, originKey: undefined })],
      today: TODAY,
    });
    expect(p.remove).toEqual([]);
  });
});
