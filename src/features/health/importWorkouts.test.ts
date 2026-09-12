import { describe, expect, it } from 'vitest';
import { parseDate, parseDistance, parseDuration, parseType, parseWorkoutsCsv, splitCsv, withoutDuplicates } from './importWorkouts';

describe('разбор ячеек', () => {
  it('даты: ISO, точки, Strava «Sep 10, 2026, 6:02:11 PM», русский месяц', () => {
    expect(parseDate('2026-09-10T18:02:11Z')).toBe('2026-09-10');
    expect(parseDate('10.09.2026')).toBe('2026-09-10');
    expect(parseDate('Sep 10, 2026, 6:02:11 PM')).toBe('2026-09-10');
    expect(parseDate('10 сен 2026')).toBe('2026-09-10');
    expect(parseDate('вчера')).toBeNull();
  });

  it('длительность: секунды Strava, ч:мм:сс, мм:сс, минуты, часы', () => {
    expect(parseDuration('5400')).toBe(90);
    expect(parseDuration('1:30:00')).toBe(90);
    expect(parseDuration('45:30')).toBe(46);
    expect(parseDuration('45')).toBe(45);
    expect(parseDuration('45 мин')).toBe(45);
    expect(parseDuration('1.5 ч')).toBe(90);
    expect(parseDuration('')).toBeNull();
  });

  it('дистанция: км с точкой и запятой, метры, единицы', () => {
    expect(parseDistance('5.2')).toBe(5.2);
    expect(parseDistance('5,2')).toBe(5.2);
    expect(parseDistance('5200')).toBe(5.2);
    expect(parseDistance('5200 m')).toBe(5.2);
    expect(parseDistance('5.2 km')).toBe(5.2);
    expect(parseDistance('')).toBeNull();
  });

  it('вид по ключевым словам, неизвестное — «другое»', () => {
    expect(parseType('Run')).toBe('run');
    expect(parseType('Утренняя пробежка')).toBe('run');
    expect(parseType('Weight Training')).toBe('strength');
    expect(parseType('Ride')).toBe('bike');
    expect(parseType('Бокс на мешке')).toBe('boxing');
    expect(parseType('Kettlebell')).toBe('kettlebell');
    expect(parseType('Шахматы')).toBe('other');
  });
});

describe('CSV целиком', () => {
  it('Strava activities.csv: дата, вид, Moving Time в секундах, дистанция', () => {
    const csv = [
      'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Moving Time',
      '1,"Sep 8, 2026, 7:01:00 AM","Morning Run",Run,2100,5.21,1920',
      '2,"Sep 10, 2026, 6:02:11 PM","Evening Workout",Weight Training,3300,,3300',
      '3,"Sep 11, 2026, 6:02:11 PM","Broken",Run,,,',
    ].join('\n');
    const r = parseWorkoutsCsv(csv);
    expect(r.skipped).toBe(1);
    expect(r.rows).toEqual([
      { date: '2026-09-08', type: 'run', minutes: 32, distanceKm: 5.21, note: 'Morning Run' },
      { date: '2026-09-10', type: 'strength', minutes: 55, distanceKm: null, note: 'Evening Workout' },
    ]);
  });

  it('простая русская таблица с точкой с запятой и BOM', () => {
    const csv = '﻿Дата;Вид;Минуты;Км\n10.09.2026;Бег;30;5,2\n11.09.2026;Гири;25;\n';
    const r = parseWorkoutsCsv(csv);
    expect(r.rows.map((x) => [x.date, x.type, x.minutes, x.distanceKm])).toEqual([
      ['2026-09-10', 'run', 30, 5.2],
      ['2026-09-11', 'kettlebell', 25, null],
    ]);
  });

  it('кавычки с запятыми внутри и без нужных колонок — не падает', () => {
    expect(splitCsv('a,"b, c",d\n1,"say ""hi""",3')).toEqual([
      ['a', 'b, c', 'd'],
      ['1', 'say "hi"', '3'],
    ]);
    expect(parseWorkoutsCsv('Foo,Bar\n1,2')).toEqual({ rows: [], skipped: 1 });
  });

  it('повторный импорт не плодит копии, но две пробежки одного дня разной длины — обе', () => {
    const rows = [
      { date: '2026-09-08', type: 'run' as const, minutes: 32, distanceKm: 5.2, note: '' },
      { date: '2026-09-08', type: 'run' as const, minutes: 32, distanceKm: 5.2, note: 'дубль в файле' },
      { date: '2026-09-08', type: 'run' as const, minutes: 32, distanceKm: 7.1, note: 'вечерняя' },
      { date: '2026-09-10', type: 'strength' as const, minutes: 55, distanceKm: null, note: '' },
    ];
    const existing = [{ date: '2026-09-10', type: 'strength' as const, minutes: 55, distanceKm: null }];
    expect(withoutDuplicates(rows, existing).map((r) => r.note)).toEqual(['', 'вечерняя']);
  });
});
