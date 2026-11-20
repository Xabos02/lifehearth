import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openApp, test } from './fixtures';

// Заморозка привычек — «осознанно отложить без чувства вины», единый концепт
// с заморозкой задач: серия перешагивает заморозку, потому что isActiveOn
// (lib/habits.ts) исключает эти дни из планирования так же честно, как обычный
// непланируемый день.

interface SeedHabit {
  id: string;
  name: string;
  frozenRanges?: Array<{ from: string; to?: string; origin: 'manual' | 'section' }>;
}

/** Живые привычки на сегодня. schedule: daily — планируются при любой дате
 *  теста (как seedHabit в e2e/sections.spec.ts). */
async function seedHabits(page: Page, habits: SeedHabit[]) {
  await page.evaluate(async (habits) => {
    const { db } = await import('/src/db/db.ts');
    const now = new Date().toISOString();
    await db.habits.clear();
    await db.habits.bulkPut(
      habits.map((h, i) => ({
        id: h.id,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        name: h.name,
        emoji: '💪',
        color: '#5b7cfa',
        schedule: { type: 'daily' as const },
        target: null,
        unit: '',
        goalId: null,
        archivedAt: null,
        sortOrder: (i + 1) * 1000,
        frozenRanges: h.frozenRanges,
      })),
    );
  }, habits);
}

/** Отметки выполнения привычки за прошедшие даты (для сборки серии до старта теста). */
async function seedHabitLogs(page: Page, habitId: string, dates: string[]) {
  await page.evaluate(
    async ({ habitId, dates }) => {
      const { db } = await import('/src/db/db.ts');
      await db.habitLogs.bulkPut(
        dates.map((date, i) => {
          const now = new Date().toISOString();
          return {
            id: `${habitId}-log-${i}`,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            habitId,
            date,
            value: null,
          };
        }),
      );
    },
    { habitId, dates },
  );
}

/** Тумблер строки раздела на экране настройки (как в e2e/sections.spec.ts). */
function toggleFor(page: Page, label: string) {
  return page.getByRole('button', { name: new RegExp(`(Выключить|Включить) раздел ${label}$`) });
}

/** Карточка привычки в списке /more/habits, найденная по названию. */
function habitCard(page: Page, name: string) {
  return page.locator('.card').filter({ hasText: name });
}

async function openHabitSheet(page: Page, name: string) {
  await habitCard(page, name).click();
  await expect(page.getByRole('heading', { name: 'Привычка' })).toBeVisible();
}

test('заморозка из шита прячет привычку с «Сегодня» и приглушает карточку в списке', async ({
  page,
}) => {
  await openApp(page, '/');
  await seedHabits(page, [{ id: 'h1', name: 'Отжимания' }]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Привычки' })).toBeVisible();
  await expect(page.getByText('Отжимания', { exact: true })).toBeVisible();

  await page.goto('/more/habits');
  await openHabitSheet(page, 'Отжимания');
  await page.getByRole('button', { name: 'Заморозить' }).click();

  // Уход на другой экран обрывает асинхронную запись: без ожидания факта
  // заморозки тест падает на собственной гонке, а не на дефекте приложения.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts');
        const h = await db.habits.get('h1');
        return (h?.frozenRanges ?? []).some((r) => !r.to);
      }),
    )
    .toBe(true);

  // ушла с «Сегодня» — блок целиком скрывается, планируемых привычек не осталось.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Привычки' })).toHaveCount(0);
  await expect(page.getByText('Отжимания', { exact: true })).toHaveCount(0);

  // в списке привычек — на месте, но приглушена и с честной подписью.
  await page.goto('/more/habits');
  const card = habitCard(page, 'Отжимания');
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/opacity-45/);
  await expect(card.getByText(/Заморожена с/)).toBeVisible();
});

test('серия переживает заморозку и разморозку в тот же день', async ({ page }) => {
  await openApp(page, '/');
  const { d1, d2 } = await page.evaluate(async () => {
    const { todayKey, addDaysKey } = await import('/src/lib/dates.ts');
    const today = todayKey();
    return { d1: addDaysKey(today, -1), d2: addDaysKey(today, -2) };
  });
  await seedHabits(page, [{ id: 'h1', name: 'Отжимания' }]);
  await seedHabitLogs(page, 'h1', [d1, d2]);

  await page.goto('/more/habits');
  const card = habitCard(page, 'Отжимания');
  // Серия — значок огня (Font Awesome, как в макете Abacus) и число.
  await expect(card.locator('.lucide-fa-fire')).toBeVisible();
  await expect(card).toContainText('· 2');

  // Заморозить...
  await openHabitSheet(page, 'Отжимания');
  await page.getByRole('button', { name: 'Заморозить' }).click();
  await expect(habitCard(page, 'Отжимания').getByText(/Заморожена с/)).toBeVisible();

  // ...и тут же разморозить — интервал схлопывается (замёрз и оттаял в один
  // день), следа не остаётся, серия по-прежнему видна, а не сгорела до 0.
  await openHabitSheet(page, 'Отжимания');
  await page.getByRole('button', { name: 'Разморозить' }).click();
  await expect(habitCard(page, 'Отжимания').locator('.lucide-fa-fire')).toBeVisible();
  await expect(habitCard(page, 'Отжимания')).toContainText('· 2');
});

test('выключение раздела «Привычки» замораживает все разом, включение снимает только эти', async ({
  page,
}) => {
  await openApp(page, '/');
  const today = await page.evaluate(async () => {
    const { todayKey } = await import('/src/lib/dates.ts');
    return todayKey();
  });
  await seedHabits(page, [
    { id: 'h1', name: 'Отжимания' },
    // Заморожена вручную ДО выключения раздела — должна остаться замороженной
    // и после включения раздела обратно.
    { id: 'h2', name: 'Медитация', frozenRanges: [{ from: today, origin: 'manual' }] },
  ]);

  await page.goto('/more/settings/sections');
  await toggleFor(page, 'Привычки').click();
  await page.waitForTimeout(300); // автосохранение settings — асинхронное

  await page.goto('/more/habits');
  await expect(habitCard(page, 'Отжимания').getByText(/Заморожена с/)).toBeVisible();
  await expect(habitCard(page, 'Медитация').getByText(/Заморожена с/)).toBeVisible();

  await page.goto('/more/settings/sections');
  await toggleFor(page, 'Привычки').click();
  await page.waitForTimeout(300);

  await page.goto('/more/habits');
  // Раздел включили — секционная заморозка снята.
  await expect(habitCard(page, 'Отжимания').getByText(/Заморожена с/)).toHaveCount(0);
  // Ручная заморозка не была затронута тумблером раздела.
  await expect(habitCard(page, 'Медитация').getByText(/Заморожена с/)).toBeVisible();
});
