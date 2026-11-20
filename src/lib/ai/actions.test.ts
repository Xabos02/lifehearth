// Инструменты записи ассистента: запись в те же поля, что у экранов, и
// отмена/подтверждение с карточки. Ошибётся запись — человек получит задачу
// не туда; ошибётся отмена — «Отменить» оставит мусор или сотрёт чужое.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Напоминания ходят в воркер — в юните их не нужно.
vi.mock('../push', () => ({
  scheduleReminder: vi.fn(async () => {}),
  cancelReminder: vi.fn(async () => {}),
}));

const { db } = await import('../../db/db');
const { runTool } = await import('./tools');
const { settleAction, shortId } = await import('./actions');
const { toContext } = await import('./llmRepo');
const push = await import('../push');
const { alive } = await import('../../db/repo');
type AiAction = import('../../db/types').AiAction;

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const run = async (name: string, args: Record<string, unknown>) => {
  const r = await runTool(name, JSON.stringify(args));
  return { ...r, json: JSON.parse(r.text) as Record<string, unknown> };
};

/** Действия, как их сохранит прогон, — в сообщение чата: кнопки карточки
 *  работают по id сообщения и номеру действия. */
async function saved(actions: AiAction[]): Promise<string> {
  const ts = new Date().toISOString();
  await db.llmMessages.add({
    id: 'm1', createdAt: ts, updatedAt: ts, deletedAt: null, chatId: 'c1', role: 'assistant', content: 'ok',
    model: 'm', tokensIn: 1, tokensOut: 1, costRub: 0, status: 'done', error: null, actions,
  });
  return 'm1';
}
const stateOf = async (i: number) => (await db.llmMessages.get('m1'))!.actions![i].state;

describe('задачи', () => {
  it('create_task: проект заводится, срок, время, повтор и чек-лист — по полям формы; отмена убирает и задачу, и проект', async () => {
    const r = await run('create_task', {
      title: 'Купить протеин',
      project: 'Спорт',
      due: '2026-11-27',
      time: '9:05',
      priority: 'high',
      repeat: { every: 'week' },
      checklist: ['вкус шоколад', ''],
      tags: ['магазин'],
    });
    expect(r.json.ok).toBe(true);
    const [task] = alive(await db.tasks.toArray());
    const [project] = alive(await db.projects.toArray());
    expect(project.name).toBe('Спорт');
    expect(task).toMatchObject({
      title: 'Купить протеин',
      projectId: project.id,
      dueDate: '2026-11-27',
      dueTime: '09:05',
      priority: 3,
      // День недели повтора — день срока (27.11.2026 — пятница), как в форме.
      recurrence: { type: 'weekly', interval: 1, weekdays: [5] },
      tags: ['магазин'],
      remindBefore: null,
      completedAt: null,
    });
    expect(task.checklist.map((c) => [c.text, c.done])).toEqual([['вкус шоколад', false]]);
    expect(r.json.id).toBe(shortId(task.id));
    expect(r.actions!.map((a) => `${a.op}.${a.kind}`)).toEqual(['create.project', 'create.task']);

    // Тот же проект второй раз не заводится — точное совпадение имени.
    await run('create_task', { title: 'Ещё', project: 'спорт' });
    expect(alive(await db.projects.toArray())).toHaveLength(1);

    await saved(r.actions!);
    await settleAction('m1', 1, 'undo');
    // В проект после ассистента легла ещё задача — отмена проекта спрашивает.
    expect(await settleAction('m1', 0, 'undo')).toBe('edited');
    expect(alive(await db.projects.toArray())).toHaveLength(1);
    await settleAction('m1', 0, 'undo', true);
    expect(alive(await db.tasks.toArray()).map((t) => t.title)).toEqual(['Ещё']);
    expect(alive(await db.projects.toArray())).toHaveLength(0);
    expect(await stateOf(1)).toBe('undone');
  });

  it('create_task: время без срока не ставится, неверная дата — понятная ошибка модели', async () => {
    await run('create_task', { title: 'Без срока', time: '10:00' });
    expect((await db.tasks.toArray())[0].dueTime).toBeNull();
    const bad = await run('create_task', { title: 'X', due: 'завтра' });
    expect(String(bad.json.error)).toContain('YYYY-MM-DD');
    expect(await db.tasks.count()).toBe(1);
  });

  it('update_task: меняет только переданное, по короткому id; отмена возвращает прежнее', async () => {
    const { json } = await run('create_task', { title: 'Отчёт', due: '2026-11-25', checklist: ['план', 'черновик'] });
    const id = String(json.id);
    const task0 = (await db.tasks.toArray())[0];
    await db.tasks.update(task0.id, { checklist: [{ ...task0.checklist[0], done: true }, task0.checklist[1]] });

    const r = await run('update_task', { id, title: 'Отчёт за ноябрь', due: '', checklist: ['план', 'итог'] });
    expect(r.json.ok).toBe(true);
    const task = (await db.tasks.toArray())[0];
    expect(task.title).toBe('Отчёт за ноябрь');
    expect(task.dueDate).toBeNull();
    // Пункт с тем же текстом сохранил галочку.
    expect(task.checklist.map((c) => [c.text, c.done])).toEqual([['план', true], ['итог', false]]);
    expect(task.notes).toBe('');

    await saved(r.actions!);
    await settleAction('m1', 0, 'undo');
    const back = (await db.tasks.toArray())[0];
    expect(back.title).toBe('Отчёт');
    expect(back.dueDate).toBe('2026-11-25');
    expect(back.checklist.map((c) => c.text)).toEqual(['план', 'черновик']);
  });

  it('complete_task: повторяющаяся — следующий круг заводится; отмена снимает отметку и убирает его', async () => {
    const { json } = await run('create_task', { title: 'Полить цветы', due: '2026-11-20', repeat: { every: 'day', interval: 3 } });
    const r = await run('complete_task', { id: json.id });
    expect(r.json.nextRepeat).toBeTruthy();
    expect(alive(await db.tasks.toArray())).toHaveLength(2);

    await saved(r.actions!);
    await settleAction('m1', 0, 'undo');
    const left = alive(await db.tasks.toArray());
    expect(left).toHaveLength(1);
    expect(left[0].completedAt).toBeNull();
    // Повторное нажатие ничего не ломает: состояние уже «отменено».
    await settleAction('m1', 0, 'undo');
    expect(alive(await db.tasks.toArray())).toHaveLength(1);
  });

  it('короткий id: короче 8, не найден, неоднозначный, задача «Женских дней» — ошибка модели, а не правка наугад', async () => {
    const ts = new Date().toISOString();
    const row = { createdAt: ts, updatedAt: ts, deletedAt: null, title: 'a', notes: '', projectId: null, goalId: null, priority: 0, dueDate: null, dueTime: null, duration: null, remindBefore: null, completedAt: null, checklist: [], recurrence: null, tags: [], sortOrder: 1 };
    await db.tasks.bulkAdd([
      { ...row, id: 'abcd1234-x' },
      { ...row, id: 'abcd1234-y' },
      { ...row, id: '0aaaaaaa-c', origin: 'cycle', title: 'Скоро начнутся' },
    ] as never[]);
    // Выдуманный моделью id «0» не попадает в запись, начинающуюся с нуля.
    expect(String((await run('complete_task', { id: '0' })).json.error)).toContain('8 символов');
    expect(String((await run('complete_task', { id: 'abcd1234' })).json.error)).toContain('нескольким');
    expect(String((await run('complete_task', { id: 'ffffffff' })).json.error)).toContain('не найдена');
    // Раздел вне доступа: ни отметить, ни переименовать, ни предложить удалить.
    expect(String((await run('complete_task', { id: '0aaaaaaa' })).json.error)).toContain('не найдена');
    expect(String((await run('update_task', { id: '0aaaaaaa', title: 'x' })).json.error)).toContain('не найдена');
    expect(String((await run('delete_record', { type: 'task', id: '0aaaaaaa' })).json.error)).toContain('не найдена');
    expect(alive(await db.tasks.toArray()).every((t) => !t.completedAt && t.title !== 'x')).toBe(true);
  });

  it('перенос срока переносит напоминание; снятое время снимает напоминание «за минуты»', async () => {
    const { json } = await run('create_task', { title: 'Врач', due: '2026-12-01', time: '10:00' });
    const t0 = (await db.tasks.toArray())[0];
    await db.tasks.update(t0.id, { remindBefore: 15 });
    vi.mocked(push.scheduleReminder).mockClear();
    await run('update_task', { id: json.id, due: '2026-12-03' });
    await vi.waitFor(() => expect(push.scheduleReminder).toHaveBeenCalledWith(expect.objectContaining({ dueDate: '2026-12-03', remindBefore: 15 })));
    await run('update_task', { id: json.id, time: '' });
    expect((await db.tasks.get(t0.id))!.remindBefore).toBeNull();
  });

  it('потолки одного вызова: чек-лист и виды тренировки', async () => {
    const big = await run('create_task', { title: 'X', checklist: Array.from({ length: 51 }, (_, i) => `п${i}`) });
    expect(String(big.json.error)).toContain('не больше 50');
    const many = await run('log_workout', { items: Array.from({ length: 13 }, () => ({ type: 'run' })) });
    expect(String(many.json.error)).toContain('не больше 12');
    expect(await db.tasks.count()).toBe(0);
    expect(await db.workouts.count()).toBe(0);
  });
});

describe('заметки, привычки, цели', () => {
  it('create_note, create_habit по дням недели, create_goal числом', async () => {
    await run('create_note', { title: 'Покупки', text: 'молоко\nхлеб <b>' });
    const note = (await db.notes.toArray())[0];
    expect(note.title).toBe('Покупки');
    // Без DOM (юнит) — строки как есть, разметка экранирована.
    expect(note.content).toBe('<div>молоко</div><div>хлеб &lt;b&gt;</div>');

    await run('create_habit', { name: 'Растяжка', days: [1, 3, 5, 9], target: 10, unit: 'мин' });
    expect((await db.habits.toArray())[0]).toMatchObject({
      name: 'Растяжка', schedule: { type: 'weekdays', weekdays: [1, 3, 5] }, target: 10, unit: 'мин', archivedAt: null,
    });

    await run('create_goal', { title: '12 книг', target: 12, unit: 'книг', due: '2026-12-31' });
    expect((await db.goals.toArray())[0]).toMatchObject({
      title: '12 книг', progressMode: 'numeric', targetValue: 12, currentValue: 0, status: 'active', targetDate: '2026-12-31',
    });
  });
});

describe('спорт', () => {
  it('шаблон тренировки: встроенный и свой вид, упражнения с диапазоном, секундами и весом', async () => {
    const r = await run('create_workout_template', {
      name: 'Фулбоди А',
      total_minutes: 60,
      items: [
        {
          type: 'strength',
          exercises: [
            { name: 'Присед', sets: 4, reps: 8, reps_to: 6, weight: '+20 кг', rest: '2 мин' },
            { name: 'Планка', sets: 3, reps: 60, unit: 'sec' },
            { name: '' },
          ],
        },
        { name: 'Йога', minutes: 15 },
      ],
    });
    expect(r.json.ok).toBe(true);
    const tpl = (await db.workoutTemplates.toArray())[0];
    expect(tpl.name).toBe('Фулбоди А');
    expect(tpl.totalMinutes).toBe(60);
    expect('note' in tpl).toBe(false);
    expect(tpl.items[0].exercises).toEqual([
      { name: 'Присед', sets: 4, reps: 6, repsTo: 8, weight: '+20 кг', rest: '2 мин' },
      { name: 'Планка', sets: 3, reps: 60, unit: 'sec' },
    ]);
    expect(tpl.items[1]).toMatchObject({ type: 'custom', customLabel: 'Йога', minutes: 15 });
    // Своё упражнение — через справочник, как «+ Своё»: цвет оттуда.
    expect((await db.exerciseDefs.toArray())[0].label).toBe('Йога');
    expect(tpl.items[1].customColor).toBeTruthy();
  });

  it('log_workout: два вида — одно занятие с общим groupId; без даты — сегодня', async () => {
    const r = await run('log_workout', { items: [{ type: 'run', minutes: 30, distance_km: 5.25 }, { type: 'stretch', distance_km: 3 }], effort: 2 });
    const rows = await db.workouts.toArray();
    expect(rows).toHaveLength(2);
    expect(rows[0].groupId).toBeTruthy();
    expect(rows[0].groupId).toBe(rows[1].groupId);
    expect(rows.find((w) => w.type === 'run')).toMatchObject({ distanceKm: 5.25, minutes: 30, effort: 2, source: 'manual' });
    // У растяжки дистанции нет — км не пишутся.
    expect(rows.find((w) => w.type === 'stretch')!.distanceKm).toBeNull();
    expect(r.actions![0].ids).toHaveLength(2);

    await saved(r.actions!);
    await settleAction('m1', 0, 'undo');
    expect(alive(await db.workouts.toArray())).toHaveLength(0);
  });
});

describe('финансы', () => {
  it('расход, копилка и пополнение; снять больше накопленного нельзя', async () => {
    await run('create_expense', { title: 'Спортзал', amount: 3500, period: 'monthly', day: 40, category: 'Спорт' });
    expect((await db.expenseItems.toArray())[0]).toMatchObject({
      title: 'Спортзал', amount: 3500, kind: 'expense', recurrence: 'monthly', dayOfMonth: 31, active: true,
    });
    const { json } = await run('create_savings_goal', { title: 'Отпуск', target: 100000 });
    await run('add_deposit', { savings_id: json.id, amount: 5000 });
    const out = await run('add_deposit', { savings_id: json.id, amount: -6000 });
    expect(String(out.json.error)).toContain('5000');
    expect((await db.savingsDeposits.toArray()).map((d) => d.amount)).toEqual([5000]);
  });
});

describe('кнопки карточки', () => {
  it('две быстрые кнопки одной карточки не затирают состояние друг друга', async () => {
    const a = await run('create_note', { title: 'Первая', text: 'x' });
    const b = await run('create_note', { title: 'Вторая', text: 'y' });
    const d1 = await run('delete_record', { type: 'note', id: a.json.id });
    const d2 = await run('delete_record', { type: 'note', id: b.json.id });
    await saved([...d1.actions!, ...d2.actions!]);
    await Promise.all([settleAction('m1', 0, 'confirm'), settleAction('m1', 1, 'confirm')]);
    expect([await stateOf(0), await stateOf(1)]).toEqual(['done', 'done']);
    expect(alive(await db.notes.toArray())).toHaveLength(0);
  });

  it('запись правили после ассистента — отмена спрашивает; с force — отменяет', async () => {
    const r = await run('create_note', { title: 'Дневник', text: 'день 1' });
    await db.notes.update(r.actions![0].ids[0], { content: '<div>неделя записей</div>', updatedAt: '2999-01-01T00:00:00.000Z' });
    await saved(r.actions!);
    expect(await settleAction('m1', 0, 'undo')).toBe('edited');
    expect(alive(await db.notes.toArray())).toHaveLength(1);
    expect(await stateOf(0)).toBe('done');
    expect(await settleAction('m1', 0, 'undo', true)).toBe('ok');
    expect(alive(await db.notes.toArray())).toHaveLength(0);
  });

  it('отмена шаблона убирает и новый вид, заведённый им в справочнике; старый вид не трогает', async () => {
    await run('create_workout_template', { name: 'Старый', items: [{ name: 'Йога' }] });
    const r = await run('create_workout_template', { name: 'Новый', items: [{ name: 'Йога' }, { name: 'Скалолазание' }] });
    expect(r.actions![0].defIds).toHaveLength(1);
    await saved(r.actions!);
    await settleAction('m1', 0, 'undo');
    expect(alive(await db.exerciseDefs.toArray()).map((d) => d.label)).toEqual(['Йога']);
  });

  it('история для модели несёт сводку изменений и их состояние — и у ответа без текста', () => {
    const base = { createdAt: 't', updatedAt: 't', deletedAt: null, chatId: 'c', model: 'm', tokensIn: 0, tokensOut: 0, costRub: 0, status: 'done' as const, error: null };
    const ctx = toContext([
      { ...base, id: '1', role: 'user', content: 'сделай' },
      {
        ...base, id: '2', role: 'assistant', content: '',
        actions: [
          { op: 'create', kind: 'task', ids: ['a'], title: 'Купить', state: 'undone' },
          { op: 'delete', kind: 'note', ids: ['b'], title: 'Черновик', state: 'pending' },
        ],
      },
    ]);
    expect(ctx).toHaveLength(2);
    expect(ctx[1].content).toContain('задача «Купить» — отменено пользователем');
    expect(ctx[1].content).toContain('заметка «Черновик» — ждёт кнопки пользователя');
  });
});

describe('удаление — только по кнопке', () => {
  it('delete_record ничего не удаляет сам; «Удалить» удаляет, «Вернуть» возвращает, «Оставить» не трогает', async () => {
    const a = await run('create_task', { title: 'Старый план' });
    const b = await run('create_note', { title: 'Черновик', text: 'x' });
    const d1 = await run('delete_record', { type: 'task', id: a.json.id });
    const d2 = await run('delete_record', { type: 'note', id: b.json.id });
    expect(d1.json.pending).toBeTruthy();
    expect(d1.actions![0]).toMatchObject({ op: 'delete', kind: 'task', state: 'pending', title: 'Старый план' });
    expect(alive(await db.tasks.toArray())).toHaveLength(1);

    await saved([...d1.actions!, ...d2.actions!]);
    await settleAction('m1', 0, 'confirm');
    expect(alive(await db.tasks.toArray())).toHaveLength(0);
    expect(await stateOf(0)).toBe('done');
    await settleAction('m1', 0, 'undo');
    expect(alive(await db.tasks.toArray())).toHaveLength(1);

    await settleAction('m1', 1, 'keep');
    expect(await stateOf(1)).toBe('undone');
    // После «Оставить» подтверждение больше не срабатывает.
    await settleAction('m1', 1, 'confirm');
    expect(alive(await db.notes.toArray())).toHaveLength(1);
  });

  it('удалять можно не всё: цель и привычка — отказ', async () => {
    const g = await run('create_goal', { title: 'Цель' });
    const r = await run('delete_record', { type: 'goal', id: g.json.id });
    expect(String(r.json.error)).toContain('только');
    expect(r.actions).toBeUndefined();
  });
});

describe('чтение отдаёт короткие id', () => {
  it('list_tasks и list_sport', async () => {
    await run('create_task', { title: 'Задача' });
    await run('create_workout_template', { name: 'Б', items: [{ type: 'run', minutes: 20 }] });
    const tasks = JSON.parse((await runTool('list_tasks', '{}')).text) as { tasks: { id: string }[] };
    expect(tasks.tasks[0].id).toHaveLength(8);
    const sport = JSON.parse((await runTool('list_sport', '{}')).text) as { templates: { id: string; name: string; items: { kind: string; minutes: number }[] }[] };
    expect(sport.templates[0]).toMatchObject({ name: 'Б', items: [{ kind: 'Бег', minutes: 20 }] });
  });
});
