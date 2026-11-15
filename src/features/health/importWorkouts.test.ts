import { describe, expect, it } from 'vitest';
import { decodeCsv, parseDate, parseDistance, parseDuration, parseType, parseWorkoutsCsv, splitCsv, withoutDuplicates } from './importWorkouts';

describe('разбор ячеек', () => {
  it('даты: ISO, точки, Strava «Sep 10, 2026, 6:02:11 PM», русский месяц', () => {
    expect(parseDate('2026-09-10T18:02:11Z')).toBe('2026-09-10');
    expect(parseDate('10.09.2026')).toBe('2026-09-10');
    expect(parseDate('Sep 10, 2026, 6:02:11 PM')).toBe('2026-09-10');
    expect(parseDate('10 сен 2026')).toBe('2026-09-10');
    expect(parseDate('вчера')).toBeNull();
  });

  it('несуществующая дата не разбирается: 31 февраля, 31 июня, месяц/день/год с днём > 12', () => {
    // Такую дату форматирование бросает RangeError — и падал весь раздел.
    expect(parseDate('31.02.2026')).toBeNull();
    expect(parseDate('31.06.2026')).toBeNull();
    expect(parseDate('9/25/2026')).toBeNull();
    expect(parseDate('9/15/2026')).toBeNull();
    expect(parseDate('2026-13-01')).toBeNull();
    expect(parseDate('Feb 30, 2026')).toBeNull();
    expect(parseDate('29.02.2028')).toBe('2028-02-29');
  });

  it('отметка с Z или смещением — день по местному времени, без пояса — как написано', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Europe/Moscow';
    try {
      expect(parseDate('2026-09-10T22:30:00Z')).toBe('2026-09-11');
      expect(parseDate('2026-09-10T22:30:00.000Z')).toBe('2026-09-11');
      expect(parseDate('2026-09-10T23:30:00+03:00')).toBe('2026-09-10');
      expect(parseDate('2026-09-10 22:30:00')).toBe('2026-09-10');
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
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
    // Так виды называет Garmin Connect: «hike»/«bike» в них не входят подстрокой.
    expect(parseType('Hiking')).toBe('walk');
    expect(parseType('Mountain Biking')).toBe('bike');
  });

  it('файл в Windows-1251 (CSV русского Excel) читается, UTF-8 — как был', () => {
    // «Дата;Вид» в кодировке 1251: кириллица А–я лежит в 0xC0–0xFF.
    const cp1251 = Uint8Array.from([...'Дата;Вид'].map((c) => (c === ';' ? 0x3b : c.charCodeAt(0) - 0x350)));
    expect(decodeCsv(cp1251.buffer)).toBe('Дата;Вид');
    expect(decodeCsv(new TextEncoder().encode('Дата;Вид').buffer)).toBe('Дата;Вид');
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

  it('Strava: Moving Time всегда в секундах — и у коротких записей', () => {
    const csv = [
      'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Moving Time',
      '1,"Sep 8, 2026, 7:01:00 AM","Short",Run,250,0.6,240',
      '2,"Sep 9, 2026, 7:01:00 AM","Accidental",Run,40,0.02,35',
      '3,"Sep 10, 2026, 7:01:00 AM","Normal",Run,2100,5.21,1920',
    ].join('\n');
    expect(parseWorkoutsCsv(csv, '2026-11-15').rows.map((r) => [r.note, r.minutes])).toEqual([
      ['Short', 4],
      ['Accidental', 1],
      ['Normal', 32],
    ]);
  });

  it('строка с несуществующей датой или датой позже сегодня — в «не разобрано»', () => {
    const csv = 'Date,Type,Minutes\n2026-09-10,Run,25\n9/25/2026,Run,30\n31.06.2026,Run,20\n2026-09-18,Run,30\n';
    const r = parseWorkoutsCsv(csv, '2026-09-17');
    expect(r.rows.map((x) => x.date)).toEqual(['2026-09-10']);
    expect(r.skipped).toBe(3);
  });

  it('кавычка посреди ячейки — просто символ, а не начало кавычек до конца файла', () => {
    const csv = 'Date,Type,Minutes,Note\n2026-09-10,Run,30,5" shoes\n2026-09-11,Run,40,ok\n2026-09-12,Run,50,fine\n';
    const r = parseWorkoutsCsv(csv, '2026-11-15');
    expect(r.rows.map((x) => x.date)).toEqual(['2026-09-10', '2026-09-11', '2026-09-12']);
    expect(r.skipped).toBe(0);
    expect(splitCsv(csv)[1]).toEqual(['2026-09-10', 'Run', '30', '5" shoes']);
    // Пробел перед кавычками, как пишут руками, — по-прежнему кавычки.
    expect(splitCsv('a, "b, c",d')).toEqual([['a', ' b, c', 'd']]);
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

  it('поправленная после импорта запись не возвращается из того же файла', () => {
    const row = { date: '2026-09-01', type: 'run' as const, minutes: 32, distanceKm: 5.21, note: 'Morning Run' };
    // Человек исправил минуты 32 → 40; ключ исходной строки остался в записи.
    const edited = { date: '2026-09-01', type: 'run' as const, minutes: 40, distanceKm: 5.21, importKey: '2026-09-01|run|32|5' };
    expect(withoutDuplicates([row], [edited])).toEqual([]);
    // А та же тренировка с новыми минутами из другого файла — тоже уже есть.
    expect(withoutDuplicates([{ ...row, minutes: 40 }], [edited])).toEqual([]);
  });
});

describe('ключ дня', () => {
  it('день должен быть в календаре: 31 февраля и 25-й месяц — нет', async () => {
    const { isDateKey } = await import('../../lib/dates');
    expect(['2026-11-15', '2024-02-29', '2026-01-01', '2026-12-31'].map(isDateKey)).toEqual([true, true, true, true]);
    expect(['2026-02-31', '2026-02-29', '2026-25-09', '2026-00-10', '2026-11-00', '', '2026-1-5', '15.11.2026'].map(isDateKey)).toEqual(
      Array(8).fill(false),
    );
  });
});

