import { describe, expect, it } from 'vitest';
import { cleanExercises, exerciseSuggestions, formatExercises } from './exercises';

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
});
