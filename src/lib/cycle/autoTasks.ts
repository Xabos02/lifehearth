// Задачи, которые раздел создаёт сам. Ровно то место, где цикл перестаёт быть
// отдельным островом и начинает участвовать в планировании.
//
// Три правила, за которые заплачено чужими ошибками:
//
// 1. Все шаблоны выключены по умолчанию и включаются поштучно. Связка полезна
//    тому, кто её попросил, и навязчива всем остальным.
// 2. Не больше двух активных автозадач одновременно. Пять штук за цикл убивают
//    доверие не только к разделу, но и ко всему списку задач.
// 3. Задачу, которую человек тронул руками, мы больше не двигаем. Приложение,
//    молча переписывающее то, что ты отредактировал, — хуже приложения, которое
//    вообще ничего не умеет.
//
// Планирование — чистая функция: на вход прогноз и текущие задачи, на выход
// список операций. Так его можно прогнать тестами, не поднимая базу.

import type { Task } from '../../db/types';
import type { CycleSettings, LocalDate } from '../../db/cycleTypes';
import { addDaysKey } from '../dates';
import type { CyclePredictionResult } from './predict';
import { t } from '../i18n';
import { EN } from '../i18n/en';

export type AutoTaskKey = 'supplies' | 'checkup';

export interface AutoTaskTemplate {
  key: AutoTaskKey;
  /** Нейтральный заголовок — по умолчанию. Список задач видно с чужого плеча
   *  чаще, чем сам раздел. */
  title: string;
  /** Прямой заголовок — если человек включил «писать прямо». */
  directTitle: string;
  hint: string;
}

export const AUTO_TASK_TEMPLATES: Record<AutoTaskKey, AutoTaskTemplate> = {
  supplies: {
    key: 'supplies',
    title: 'Пополнить запасы',
    directTitle: 'Купить прокладки или тампоны',
    hint: 'Появляется за несколько дней до ожидаемой менструации',
  },
  checkup: {
    key: 'checkup',
    title: 'Плановый визит к врачу',
    directTitle: 'Записаться к гинекологу',
    hint: 'Раз в год, без привязки к циклу',
  },
};

/** За сколько дней до НИЖНЕЙ границы прогноза ставить «пополнить запасы».
 *  Именно до нижней, а не до центральной: задача, появившаяся после начала
 *  менструации, бесполезна, а появившаяся слишком рано — просто висит. */
const SUPPLIES_LEAD_DAYS = 4;

/** Максимум незавершённых автозадач одновременно. */
export const MAX_ACTIVE_AUTO_TASKS = 2;

/** Раз в сколько дней напоминать о плановом визите. */
const CHECKUP_PERIOD_DAYS = 365;

export interface AutoTaskPlan {
  create: { originKey: AutoTaskKey; title: string; dueDate: LocalDate }[];
  /** Сдвиг даты у уже созданной задачи — прогноз поехал. */
  reschedule: { id: string; dueDate: LocalDate }[];
  /** Задача больше не нужна: шаблон выключили. Удаляем только нетронутые. */
  remove: string[];
}

export interface PlanInput {
  settings: CycleSettings;
  prediction: CyclePredictionResult;
  /** Все задачи раздела, включая выполненные. */
  existing: Task[];
  today: LocalDate;
  /** Тексты, которые сейчас считаются «нашими»: задачу с другим заголовком
   *  человек переименовал, и трогать её нельзя. */
  neutralTitles?: boolean;
}

const titleFor = (tpl: AutoTaskTemplate, neutral: boolean): string =>
  neutral ? t(tpl.title) : t(tpl.directTitle);

/** Задачу редактировали руками? Тогда она больше не наша.
 *
 *  Проверяем по updatedAt нельзя: отметка «выполнено» тоже его меняет, и по
 *  нему любая закрытая задача выглядела бы отредактированной. Поэтому смотрим
 *  на следы правки — то, чего у только что созданной задачи не бывает.
 *
 *  Заголовка мало. Задачу, поставленную приложением, человек дополняет:
 *  дописывает заметку, заводит чек-лист, двигает срок под свой график. Раньше
 *  всё это не считалось: приложение при следующем пересчёте возвращало свою
 *  дату, и перенесённая на выходные задача снова оказывалась в будни. */
function isUntouched(task: Task, template: AutoTaskTemplate): boolean {
  // Заголовок хранится в задаче на языке, действовавшем при создании, — после
  // смены языка задача не должна считаться «переименованной». Сверяем со всеми
  // известными формами шаблона: русскими и их словарными переводами.
  const sameTitle = [
    template.title,
    template.directTitle,
    EN[template.title] ?? template.title,
    EN[template.directTitle] ?? template.directTitle,
  ].includes(task.title);
  if (!sameTitle) return false;
  // Дописанная заметка, заведённый чек-лист, добавленные снимки, привязка к
  // проекту или цели — всё это следы того, что задачу взяли в работу.
  if ((task.notes ?? '').trim()) return false;
  if ((task.checklist ?? []).length > 0) return false;
  if ((task.photos ?? []).length > 0) return false;
  if (task.projectId || task.goalId) return false;
  return true;
}

export function planAutoTasks(input: PlanInput): AutoTaskPlan {
  const { settings, prediction, existing, today } = input;
  const neutral = input.neutralTitles ?? settings.neutralNotificationText;
  const plan: AutoTaskPlan = { create: [], reschedule: [], remove: [] };

  const enabled = settings.integrations.autoTasks;
  const byKey = new Map<string, Task[]>();
  for (const t of existing) {
    if (t.origin !== 'cycle' || t.deletedAt) continue;
    const arr = byKey.get(t.originKey ?? '');
    if (arr) arr.push(t);
    else byKey.set(t.originKey ?? '', [t]);
  }
  const activeOf = (key: AutoTaskKey) =>
    (byKey.get(key) ?? []).filter((t) => !t.completedAt);

  // Шаблоны выключили — убираем только то, чего человек не касался. Задачу,
  // которую он переименовал или уже выполнил, оставляем: это его запись.
  if (!enabled) {
    for (const [key, tasks] of byKey) {
      const tpl = AUTO_TASK_TEMPLATES[key as AutoTaskKey];
      if (!tpl) continue;
      for (const t of tasks) {
        if (!t.completedAt && isUntouched(t, tpl)) plan.remove.push(t.id);
      }
    }
    return plan;
  }

  const activeTotal = [...byKey.values()].flat().filter((t) => !t.completedAt).length;
  // Бюджет считается от уже созданных плюс тех, что запланированы в этом же
  // проходе: иначе два шаблона подряд создали бы по задаче каждый, не увидев
  // друг друга, и лимит превратился бы в украшение.
  const budgetLeft = () =>
    MAX_ACTIVE_AUTO_TASKS - activeTotal - plan.create.length > 0;

  // --- Пополнить запасы ---
  if (prediction.lo80 !== undefined && settings.predictionsEnabled) {
    const due = addDaysKey(prediction.lo80, -SUPPLIES_LEAD_DAYS);
    const tpl = AUTO_TASK_TEMPLATES.supplies;
    const active = activeOf('supplies');
    if (active.length === 0) {
      // Не создаём задачу в прошлом: она появилась бы сразу просроченной.
      if (due >= today && budgetLeft()) {
        plan.create.push({ originKey: 'supplies', title: titleFor(tpl, neutral), dueDate: due });
      }
    } else {
      const t = active[0];
      if (t.dueDate !== due && isUntouched(t, tpl)) {
        plan.reschedule.push({ id: t.id, dueDate: due });
      }
    }
  }

  // --- Плановый визит ---
  if (activeOf('checkup').length === 0 && budgetLeft()) {
    const done = (byKey.get('checkup') ?? [])
      .filter((t) => t.completedAt)
      .sort((a, b) => (a.completedAt! < b.completedAt! ? 1 : -1))[0];
    const lastDate = done?.completedAt?.slice(0, 10);
    // Первый раз ставим не сегодня, а через месяц: человек только включил
    // раздел, и задача «к врачу» в первый же день выглядит как диагноз.
    const due = lastDate === undefined ? addDaysKey(today, 30) : addDaysKey(lastDate, CHECKUP_PERIOD_DAYS);
    if (due >= today) {
      plan.create.push({
        originKey: 'checkup',
        title: titleFor(AUTO_TASK_TEMPLATES.checkup, neutral),
        dueDate: due,
      });
    }
  }

  return plan;
}
