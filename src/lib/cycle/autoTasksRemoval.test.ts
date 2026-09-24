// Что происходит с автозадачами, когда связку с задачами выключают.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, DEFAULT_SETTINGS } from '../../db/db';
import { updateSettings } from '../../hooks/useSettings';
import { syncAutoTasks, updateCycleSettings, ensureCycleSetup } from './cycleRepo';

const NOW = '2026-08-22T10:00:00.000Z';

async function seedAutoTask(id: string, extra: Record<string, unknown> = {}) {
  await db.tasks.put({
    id,
    title: 'Купить прокладки или тампоны',
    notes: '',
    checklist: [],
    origin: 'cycle',
    originKey: 'supplies',
    dueDate: '2026-09-01',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    completedAt: null,
  } as never);
  if (Object.keys(extra).length) await db.tasks.update(id, extra as never);
}

describe('выключение связки с задачами', () => {
  beforeEach(async () => {
    await db.open();
    await Promise.all(db.tables.map((t) => t.clear()));
    // Женский профиль — как у всех, кто видит раздел. Без него задачи уходят
    // в корзину уже потому, что раздела у профиля нет (пол сильнее тумблера),
    // и тесты про выключенную связку проверяли бы пол, а не тумблер: мутант
    // «syncAutoTasks игнорирует тумблер» проходил весь набор.
    await db.settings.put({ ...DEFAULT_SETTINGS, gender: 'female' });
  });

  it('автозадача уходит в корзину, а не стирается насовсем', async () => {
    // Полное удаление уносило вместе с задачей заметки и чек-лист, которые
    // человек мог к ней дописать, и вернуть их было нечем. Хуже того, оно не
    // доезжало до второго устройства: синхронизация возит пометку об удалении,
    // а не отсутствие записи, — телефон присылал задачу обратно.
    await seedAutoTask('auto-1');
    await ensureCycleSetup();
    await updateCycleSettings({ integrations: { autoTasks: false } as never });

    await syncAutoTasks();

    const task = await db.tasks.get('auto-1');
    // Запись на месте — с пометкой об удалении.
    expect(task).toBeTruthy();
    expect(task?.deletedAt).toBeTruthy();
  });

  it('дописанное человеком не исчезает вместе с задачей', async () => {
    await seedAutoTask('auto-1', { notes: 'взять ночные, в «Магните»' });
    await ensureCycleSetup();
    await updateCycleSettings({ integrations: { autoTasks: false } as never });

    await syncAutoTasks();

    // Задача в корзине, и заметка при ней: её можно восстановить.
    expect((await db.tasks.get('auto-1'))?.notes).toBe('взять ночные, в «Магните»');
  });

  it('смена пола на мужской уносит нетронутые автозадачи в корзину', async () => {
    // У мужского профиля раздела нет — и его задач в общем списке тоже быть
    // не должно. Раньше они оставались: план автозадач пола не знал, а смена
    // пола его и не запускала. Тронутую человеком — не трогаем, как и при
    // выключенной связке: это уже его запись.
    await seedAutoTask('auto-1');
    await seedAutoTask('mine', { notes: 'взять выписку' });
    await ensureCycleSetup();
    await updateCycleSettings({ integrations: { autoTasks: true } as never });

    await updateSettings({ gender: 'male' });

    expect((await db.tasks.get('auto-1'))?.deletedAt).toBeTruthy();
    expect((await db.tasks.get('mine'))?.deletedAt).toBeFalsy();
  });

  it('сбой пересчёта задач не отменяет уже сохранённые настройки', async () => {
    // Пересчёт идёт после записи. Если он падал, падало и сохранение — уже
    // записанное: снятие кода (PinSection.remove) не доходило до
    // lockCycleSection(), сохранение кода — до очистки полей. Пересчёт цикла
    // (rebuildCycles) такую ошибку глушит давно — теперь так же и здесь.
    await ensureCycleSetup();
    const broken = vi.spyOn(db.tasks, 'where').mockImplementation(() => {
      throw new Error('сбой пересчёта задач');
    });
    try {
      await expect(updateCycleSettings({ lock: 'none' })).resolves.toBeUndefined();
      await expect(updateSettings({ gender: 'male' })).resolves.toBeUndefined();
      // Пересчёт действительно падал, а не прошёл мимо.
      expect(broken).toHaveBeenCalledTimes(2);
    } finally {
      broken.mockRestore();
    }
    expect((await db.cycleSettings.get('app'))?.lock).toBe('none');
    expect((await db.settings.get('app'))?.gender).toBe('male');
  });
});
