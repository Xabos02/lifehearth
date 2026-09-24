import { describe, expect, it } from 'vitest';
import { compareToFigo, detectAnomalies } from './anomalies';
import { deriveCycles } from './derive';
import { forecastStats } from './stats';
import type { BleedingLevel, Cycle, CycleDayLog, CycleEpisode, LocalDate } from '../../db/cycleTypes';
import { MENSTRUAL_LEVELS } from '../../db/cycleTypes';
import { addDaysKey } from '../dates';

const NOW = '2026-07-25T10:00:00.000Z';
const TODAY = '2026-07-25';

function chain(start: LocalDate, lengths: number[], periodLen = 5): Cycle[] {
  const out: Cycle[] = [];
  let cursor = start;
  for (const len of lengths) {
    out.push({
      startDate: cursor,
      endDate: addDaysKey(cursor, len - 1),
      lengthDays: len,
      periodEndDate: addDaysKey(cursor, periodLen - 1),
      periodLengthDays: periodLen,
      status: 'complete',
      excluded: 0,
      hasDataGaps: 0,
      startConfirmed: 0,
      derivedAt: NOW,
    });
    cursor = addDaysKey(cursor, len);
  }
  return out;
}

function daysFor(cycles: Cycle[], level: BleedingLevel = 'medium'): CycleDayLog[] {
  const out: CycleDayLog[] = [];
  for (const c of cycles) {
    const len = c.lengthDays ?? 28;
    for (let i = 0; i < len; i++) {
      const date = addDaysKey(c.startDate, i);
      const inPeriod = i < (c.periodLengthDays ?? 5);
      const bleeding: BleedingLevel = inPeriod ? level : 'none';
      out.push({
        date,
        bleeding,
        isBleedingDay: MENSTRUAL_LEVELS.includes(bleeding) ? 1 : 0,
        createdAt: NOW,
        updatedAt: NOW,
        source: 'user',
      });
    }
  }
  return out;
}

const kinds = (cycles: Cycle[], days: CycleDayLog[], extra = {}) =>
  detectAnomalies({ cycles, days, today: TODAY, ...extra }).map((a) => a.kind);

const dayOf = (date: LocalDate, bleeding: BleedingLevel): CycleDayLog => ({
  date,
  bleeding,
  isBleedingDay: MENSTRUAL_LEVELS.includes(bleeding) ? 1 : 0,
  createdAt: NOW,
  updatedAt: NOW,
  source: 'user',
});

/** Одна менструация за полгода — при том, что полгода и наблюдали: первая
 *  отметка («не было») лежит раньше начала окна. */
function rareButTracked() {
  const cycles = chain('2026-05-01', [45]);
  return { cycles, days: [dayOf('2026-01-01', 'none'), ...daysFor(cycles)] };
}

describe('detectAnomalies', () => {
  it('на ровных циклах молчит', () => {
    const cycles = chain('2026-02-01', [28, 28, 29, 27, 28, 28]);
    expect(kinds(cycles, daysFor(cycles))).toEqual([]);
  });

  it('ловит размах 17 дней и больше', () => {
    const cycles = chain('2026-02-01', [22, 39, 26, 30]);
    const found = detectAnomalies({ cycles, days: daysFor(cycles), today: TODAY });
    const irregular = found.find((a) => a.kind === 'irregular');
    expect(irregular).toBeDefined();
    // В тексте обязаны быть её собственные числа: предупреждение без чисел
    // читается как приговор неизвестно на каком основании.
    expect(irregular!.detail).toContain('22');
    expect(irregular!.detail).toContain('39');
    expect(irregular!.detail).toContain('17');
  });

  it('размах 16 дней ещё не повод — порог не «примерно», а ровный', () => {
    const cycles = chain('2026-02-01', [23, 39, 28, 30]);
    // 39 − 23 = 16
    expect(kinds(cycles, daysFor(cycles))).not.toContain('irregular');
  });

  it('о разной длине говорит о тех же циклах, что и «Статистика»', () => {
    // Было: на одном экране карточка писала «самый длинный 65 — разница 43
    // дня», а «Статистика» ниже — «самый короткий и длинный 22 и 40». 65 дней
    // — две менструации, вторую не отметили (derive: пропуски), и в выборку
    // экрана такой цикл не входит. Карточка обязана смотреть на неё же.
    const cycles = chain('2026-02-10', [22, 40, 65, 28]);
    cycles[2].hasDataGaps = 1;
    const irregular = detectAnomalies({ cycles, days: daysFor(cycles), today: TODAY }).find(
      (a) => a.kind === 'irregular',
    );
    const { stats } = forecastStats(cycles);

    expect([stats.shortestLength, stats.longestLength]).toEqual([22, 40]);
    expect(irregular?.detail).toBe(
      'За полгода самый короткий цикл 22 дня, самый длинный 40 — разница 18 дней.',
    );
  });

  it('меньше трёх завершённых циклов — не судим о регулярности', () => {
    const cycles = chain('2026-06-01', [22, 41]);
    expect(kinds(cycles, daysFor(cycles))).not.toContain('irregular');
  });

  it('ловит редкие менструации', () => {
    const { cycles, days } = rareButTracked();
    expect(kinds(cycles, days)).toContain('infrequent');
  });

  it('после самой первой отметки про редкие менструации молчит — сравнивать не с чем', () => {
    // Одно начало в окне при недельной истории читалось как «менструаций за
    // полгода меньше обычного».
    const first = [dayOf(TODAY, 'medium')];
    expect(kinds(deriveCycles({ days: first, today: TODAY, now: NOW }), first)).not.toContain(
      'infrequent',
    );
    // Три месяца отметок — тоже ещё не полгода.
    const cycles = chain('2026-04-25', [45]);
    expect(kinds(cycles, daysFor(cycles))).not.toContain('infrequent');
  });

  it('на подавляющем методе про редкие менструации молчит', () => {
    const { cycles, days } = rareButTracked();
    expect(kinds(cycles, days, { onSuppressiveMethod: true })).not.toContain('infrequent');
  });

  it('активный эпизод гасит разговор о редких менструациях', () => {
    const { cycles, days } = rareButTracked();
    const episodes: CycleEpisode[] = [
      { id: 'e1', kind: 'pregnancy', startDate: '2026-06-20', createdAt: NOW, updatedAt: NOW },
    ];
    expect(kinds(cycles, days, { episodes })).not.toContain('infrequent');
  });

  it('ловит затяжные менструации, если их было минимум две', () => {
    const cycles = chain('2026-02-01', [28, 28, 28, 28, 28, 28]);
    cycles[0].periodLengthDays = 11;
    cycles[2].periodLengthDays = 12;
    expect(kinds(cycles, daysFor(cycles))).toContain('prolonged');

    const once = chain('2026-02-01', [28, 28, 28, 28, 28, 28]);
    once[0].periodLengthDays = 11;
    expect(kinds(once, daysFor(once))).not.toContain('prolonged');
  });

  it('ловит мазню между менструациями и не путает её с концом менструации', () => {
    const cycles = chain('2026-03-01', [28, 28, 28, 28]);
    const days = daysFor(cycles);
    const mark = (date: LocalDate) => {
      const d = days.find((x) => x.date === date)!;
      d.bleeding = 'spotting';
      d.isBleedingDay = 0;
    };
    // Мазня на 15-й день двух разных циклов — это межменструальное кровотечение.
    mark(addDaysKey(cycles[0].startDate, 14));
    mark(addDaysKey(cycles[1].startDate, 14));
    expect(kinds(cycles, days)).toContain('intermenstrual');

    // А мазня сразу после менструации — обычный её хвост, не повод.
    const tail = daysFor(cycles);
    for (const c of cycles) {
      const d = tail.find((x) => x.date === addDaysKey(c.periodEndDate!, 1))!;
      d.bleeding = 'spotting';
      d.isBleedingDay = 0;
    }
    expect(kinds(cycles, tail)).not.toContain('intermenstrual');
  });

  it('ловит отсутствие менструации 90 дней', () => {
    const cycles = chain('2026-03-01', [28]);
    // Последнее начало — 2026-03-01, сегодня 2026-07-25: 146 дней.
    const found = detectAnomalies({ cycles, days: daysFor(cycles), today: TODAY });
    const am = found.find((a) => a.kind === 'amenorrhea');
    expect(am).toBeDefined();
    expect(am!.detail).toContain('146');
  });

  it('внутри беременности про отсутствие менструации не заговаривает', () => {
    const cycles = chain('2026-03-01', [28]);
    const episodes: CycleEpisode[] = [
      { id: 'e1', kind: 'pregnancy', startDate: '2026-03-20', createdAt: NOW, updatedAt: NOW },
    ];
    expect(kinds(cycles, daysFor(cycles), { episodes })).not.toContain('amenorrhea');
  });

  it('ловит обильные менструации по трём дням подряд в двух циклах', () => {
    const cycles = chain('2026-03-01', [28, 28, 28, 28]);
    const days = daysFor(cycles, 'heavy');
    expect(kinds(cycles, days)).toContain('heavy');

    // Один обильный цикл из четырёх — не повод.
    const mostlyLight = daysFor(cycles, 'light');
    for (let i = 0; i < 3; i++) {
      const d = mostlyLight.find((x) => x.date === addDaysKey(cycles[0].startDate, i))!;
      d.bleeding = 'heavy';
    }
    expect(kinds(cycles, mostlyLight)).not.toContain('heavy');
  });

  it('ни одно предупреждение не звучит как диагноз или приказ', () => {
    const cycles = chain('2026-02-01', [22, 39, 26, 30]);
    cycles[0].periodLengthDays = 11;
    cycles[2].periodLengthDays = 12;
    const found = detectAnomalies({ cycles, days: daysFor(cycles, 'heavy'), today: TODAY });
    expect(found.length).toBeGreaterThan(0);
    for (const a of found) {
      const text = a.title + ' ' + a.detail;
      expect(text).not.toMatch(/срочно|немедленно|опасн|патолог|заболеван|диагноз|болезн/i);
      // Заголовок — наблюдение, а не команда.
      expect(a.title).not.toMatch(/^(Обратитесь|Сходите|Сдайте|Проверьте)/);
    }
  });
});

describe('compareToFigo', () => {
  it('без возрастной группы берёт самый мягкий порог', () => {
    const r = compareToFigo(chain('2026-01-01', [28, 30]));
    expect(r.spreadThreshold).toBe(9);
  });

  it('для 26–41 порог строже', () => {
    const r = compareToFigo(chain('2026-01-01', [28, 30]), '26_41');
    expect(r.spreadThreshold).toBe(7);
    expect(r.spreadTypical).toBe(true);
  });

  it('цикл в 22 дня выходит за рамку FIGO, но остаётся валидными данными', () => {
    const r = compareToFigo(chain('2026-01-01', [22, 28]));
    expect(r.cycleLengthTypical).toBe(false);
  });

  it('на пустых данных ничего не утверждает', () => {
    const r = compareToFigo([]);
    expect(r.cycleLengthTypical).toBeNull();
    expect(r.spreadTypical).toBeNull();
    expect(r.bleedingTypical).toBeNull();
  });
});

describe('числительные в текстах о здоровье', () => {
  // Тексты читает человек, и читает про своё здоровье. «21 дней», «91 дней»
  // и «5 менструации» были тремя разными багами в трёх разных подсказках.
  const cyclesOf = (lengths: number[]) => {
    let start = '2026-01-01';
    return lengths.map((len) => {
      const c: Cycle = {
        startDate: start,
        endDate: addDaysKey(start, len - 1),
        lengthDays: len,
        periodLengthDays: 5,
        status: 'complete',
        excluded: 0,
        hasDataGaps: 0,
        startConfirmed: 1,
        derivedAt: '2026-01-01T00:00:00.000Z',
      };
      start = addDaysKey(start, len);
      return c;
    });
  };

  it('разница длин циклов склоняется', () => {
    // 21 и 22 — разные формы, и обе ломались одинаково.
    const out = detectAnomalies({
      cycles: cyclesOf([21, 40, 22]),
      days: [],
      episodes: [],
      today: '2026-04-01',
    });
    const irr = out.find((a) => a.kind === 'irregular');
    expect(irr?.detail).toContain('21 день');
    expect(irr?.detail).not.toMatch(/\d+ дней, самый|21 дней/);
  });

  it('число долгих менструаций склоняется', () => {
    const long = cyclesOf([28, 28, 28, 28, 28]).map((c) => ({ ...c, periodLengthDays: 11 }));
    const out = detectAnomalies({ cycles: long, days: [], episodes: [], today: '2026-06-01' });
    const p = out.find((a) => a.kind === 'prolonged');
    expect(p?.detail).toMatch(/За полгода \d+ менструаци[йи] длились/);
    expect(p?.detail).toContain('10 дней');
  });

  it('давность последней менструации склоняется', () => {
    const out = detectAnomalies({
      cycles: cyclesOf([28]),
      days: [{ date: '2026-01-01', isBleedingDay: 1, bleeding: 'moderate' } as never],
      episodes: [],
      today: '2026-04-02', // 91 день
    });
    const a = out.find((x) => x.kind === 'amenorrhea');
    expect(a?.detail).toContain('91 день');
    expect(a?.detail).not.toContain('91 дней');
  });
});
