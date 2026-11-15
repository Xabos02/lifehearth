import { describe, expect, it } from 'vitest';
import { cleanExercises, exerciseSuggestions, formatAmount, formatExercises } from './exercises';
import { exerciseRow, itemFromSaved, savedFromItem } from './workoutItem';
import { templateSummary } from './workoutText';

describe('упражнения внутри вида', () => {
  it('строка без имени выпадает, пустые и нулевые подходы — null', () => {
    expect(
      cleanExercises([
        { name: ' Отжимания ', sets: '3', reps: '15' },
        { name: '', sets: '3', reps: '10' },
        { name: 'Планка', sets: '', reps: '0' },
      ]),
    ).toEqual([
      { name: 'Отжимания', sets: 3, reps: 15 },
      { name: 'Планка', sets: null, reps: null },
    ]);
  });

  it('строка списка: «3×15», одни повторы, одно имя', () => {
    expect(
      formatExercises([
        { name: 'Отжимания', sets: 3, reps: 15 },
        { name: 'Планка', sets: null, reps: 60 },
        { name: 'Махи', sets: null, reps: null },
      ]),
    ).toBe('Отжимания 3×15 · Планка 60 · Махи');
    expect(formatExercises(undefined)).toBe('');
  });

  it('подсказки — только этого вида, свежие первыми, без уже добавленных и повторов', () => {
    const sources = [
      { type: 'strength' as const, customLabel: null, exercises: [{ name: 'Отжимания', sets: 3, reps: 20 }] },
      { type: 'run' as const, customLabel: null, exercises: [{ name: 'Ускорения', sets: 5, reps: null }] },
      {
        type: 'strength' as const,
        customLabel: null,
        exercises: [
          { name: 'отжимания', sets: 3, reps: 15 },
          { name: 'Планка', sets: 3, reps: 60 },
          { name: 'Колесо', sets: 2, reps: 10 },
        ],
      },
    ];
    expect(exerciseSuggestions(sources, { type: 'strength', customLabel: null }, ['Колесо'])).toEqual([
      { name: 'Отжимания', sets: 3, reps: 20 },
      { name: 'Планка', sets: 3, reps: 60 },
    ]);
    // Своё упражнение-вид отличается по названию, а не только по type='custom'.
    const custom = [{ type: 'custom' as const, customLabel: 'Йога', exercises: [{ name: 'Собака', sets: null, reps: null }] }];
    expect(exerciseSuggestions(custom, { type: 'custom', customLabel: 'Пилатес' }, [])).toEqual([]);
  });

  // Программа владельца (15.11.2026): диапазон, секунды и метры, вес, отдых,
  // пометка — и ни одного лишнего ключа у упражнения «3 × 15».
  it('диапазон, единицы, вес, отдых и пометка сохраняются; пустых ключей нет', () => {
    expect(
      cleanExercises([
        { name: 'Подтягивания с поясом', sets: '4', reps: '6', repsTo: '8', unit: null, weight: ' +10–15 кг ', rest: '2 мин', note: ' Разминка 1×5–6 ' },
        { name: 'Изометрия на шею', sets: '2', reps: '12', repsTo: '15', unit: 'sec', rest: '30 сек' },
        { name: 'Сани', sets: '4', reps: '20', unit: 'm', weight: '', rest: '  ', note: '' },
        { name: 'Отжимания', sets: '3', reps: '15', repsTo: '', unit: null, weight: '', rest: '', note: '' },
      ]),
    ).toStrictEqual([
      { name: 'Подтягивания с поясом', sets: 4, reps: 6, repsTo: 8, weight: '+10–15 кг', rest: '2 мин', note: 'Разминка 1×5–6' },
      { name: 'Изометрия на шею', sets: 2, reps: 12, repsTo: 15, unit: 'sec', rest: '30 сек' },
      { name: 'Сани', sets: 4, reps: 20, unit: 'm' },
      { name: 'Отжимания', sets: 3, reps: 15 },
    ]);
  });

  it('границы диапазона встают по порядку; одна граница и равные — одно число; единица без числа не хранится', () => {
    const one = (r: Parameters<typeof cleanExercises>[0][number]) => cleanExercises([r])[0];
    expect(one({ name: 'А', sets: '', reps: '8', repsTo: '6' })).toStrictEqual({ name: 'А', sets: null, reps: 6, repsTo: 8 });
    expect(one({ name: 'Б', sets: '', reps: '', repsTo: '8' })).toStrictEqual({ name: 'Б', sets: null, reps: 8 });
    expect(one({ name: 'В', sets: '', reps: '8', repsTo: '8' })).toStrictEqual({ name: 'В', sets: null, reps: 8 });
    expect(one({ name: 'Г', sets: '3', reps: '', repsTo: 'abc', unit: 'sec' })).toStrictEqual({ name: 'Г', sets: 3, reps: null });
  });

  it('число строкой: диапазон, единицы, одни подходы, в редакторе — с пробелами', () => {
    expect(formatAmount({ name: 'x', sets: 4, reps: 6, repsTo: 8 })).toBe('4×6–8');
    expect(formatAmount({ name: 'x', sets: 4, reps: 6, repsTo: 8 }, ' × ')).toBe('4 × 6–8');
    expect(formatAmount({ name: 'x', sets: 2, reps: 12, repsTo: 15, unit: 'sec' }, ' × ')).toBe('2 × 12–15 сек');
    expect(formatAmount({ name: 'x', sets: null, reps: 3, unit: 'min' })).toBe('3 мин');
    expect(formatAmount({ name: 'x', sets: 4, reps: 20, unit: 'm' })).toBe('4×20 м');
    expect(formatAmount({ name: 'x', sets: 3, reps: null })).toBe('3 подх.');
    expect(formatAmount({ name: 'x', sets: null, reps: null })).toBe('');
    // В строке списка вес виден, отдых и пометка — нет.
    expect(formatExercises([{ name: 'Брусья', sets: 4, reps: 8, repsTo: 10, weight: '+17,5 кг', rest: '2 мин', note: 'локти' }])).toBe('Брусья 4×8–10, +17,5 кг');
  });

  it('вид шаблона проходит через форму без потерь и без лишних ключей', () => {
    const saved = {
      type: 'strength' as const,
      customLabel: null,
      customColor: null,
      minutes: 45,
      distanceKm: null,
      exercises: [
        { name: 'Подтягивания с поясом', sets: 4, reps: 6, repsTo: 8, weight: '+10–15 кг', rest: '2 мин', note: 'Разминка 1×5–6' },
        { name: 'Раунд 1', sets: null, reps: 3, unit: 'min' as const, rest: '1 мин' },
        { name: 'Отжимания', sets: 3, reps: 15 },
      ],
    };
    expect(savedFromItem(itemFromSaved(saved, true))).toStrictEqual(saved);
    // Сохранённое упражнение читается строкой, новая пустая строка открыта.
    expect(itemFromSaved(saved, true).exercises.every((e) => !e.open)).toBe(true);
    expect(itemFromSaved(saved, true).collapsed).toBe(true);
    expect(itemFromSaved(saved).collapsed).toBe(false);
    expect(exerciseRow().open).toBe(true);
  });

  it('сводка шаблона: виды без повторов, общее время важнее суммы минут', () => {
    const item = (type: 'run' | 'strength' | 'boxing', minutes: number) => ({ type, customLabel: null, customColor: null, minutes, distanceKm: null });
    expect(templateSummary({ items: [item('run', 12), item('strength', 45), item('boxing', 11)] })).toBe('Бег, Силовая, Бокс · 1 ч 8 м');
    expect(templateSummary({ items: [item('run', 12), item('strength', 45)], totalMinutes: 70 })).toBe('Бег, Силовая · 1 ч 10 м');
    expect(templateSummary({ items: [item('boxing', 0), item('strength', 0), item('boxing', 0)] })).toBe('Бокс, Силовая');
    expect(templateSummary({ items: [item('strength', 0)], totalMinutes: 50 })).toBe('Силовая · 50 мин');
  });

  // Находка первого круга проверки (15.11.2026): правка импортированной
  // записи «Другое» (лыжи 12,5 км) молча стирала километры.
  it('километры у вида без дистанции переживают правку записи, но не смену вида', () => {
    const ski = { type: 'other' as const, customLabel: null, customColor: null, minutes: 60, distanceKm: 12.5 };
    const form = itemFromSaved(ski);
    expect(form.keepsDistance).toBe(true);
    expect(savedFromItem(form).distanceKm).toBe(12.5);
    // Вид сменили на силовую — ItemFields снимает флаг, км не тянутся следом.
    expect(savedFromItem({ ...form, type: 'strength', keepsDistance: false }).distanceKm).toBeNull();
    // У бега флаг не нужен: дистанция — его собственное поле.
    expect(itemFromSaved({ ...ski, type: 'run' }).keepsDistance).toBe(false);
  });
});
