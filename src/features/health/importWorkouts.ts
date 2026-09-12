import type { Workout, WorkoutType } from '../../db/types';

// Импорт тренировок из CSV — то, что реально можно «подтянуть из других
// приложений» веб-приложению: Apple Health для него закрыт, Strava с 2026
// пускает к API только по платной подписке. Зато файл выгрузки есть у всех:
// Strava («activities.csv» из bulk export), Garmin Connect, Google Таблицы.
//
// Разбор терпимый: колонки ищутся по имени в нескольких написаниях, дата — в
// нескольких форматах, длительность — секундами, минутами или «ч:мм:сс».
// Строка, у которой не разобрались дата или длительность, пропускается и
// считается в skipped — молча выдумывать значения нельзя.

export interface ParsedWorkout {
  date: string;
  type: WorkoutType;
  minutes: number;
  distanceKm: number | null;
  note: string;
}

export interface ParseResult {
  rows: ParsedWorkout[];
  skipped: number;
}

/** Разбить CSV на строки и ячейки: кавычки, запятые внутри кавычек, ; как
 *  разделитель у русского Excel. */
export function splitCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const sep = detectSeparator(text);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x.trim() !== '')) out.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) out.push(row);
  return out;
}

function detectSeparator(text: string): string {
  const head = text.split(/\r?\n/, 1)[0] ?? '';
  const commas = (head.match(/,/g) ?? []).length;
  const semis = (head.match(/;/g) ?? []).length;
  return semis > commas ? ';' : ',';
}

const COLUMNS: Record<'date' | 'type' | 'duration' | 'distance' | 'note', string[]> = {
  date: ['activity date', 'date', 'start time', 'дата', 'начало'],
  type: ['activity type', 'type', 'sport', 'вид', 'тип', 'activity name', 'название'],
  duration: ['moving time', 'elapsed time', 'time', 'duration', 'minutes', 'длительность', 'минуты', 'время'],
  distance: ['distance', 'дистанция', 'км', 'km'],
  note: ['activity name', 'name', 'title', 'заметка', 'описание', 'description'],
};

function findColumn(header: string[], names: string[]): number {
  const norm = header.map((h) => h.trim().toLowerCase());
  for (const n of names) {
    const i = norm.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, май: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12,
};

/** 'YYYY-MM-DD' из строки даты; null — не разобрано. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO, с временем или без
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/); // 10.09.2026, 10/09/2026 (день первым)
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/^([A-Za-zА-Яа-яё]+)\.? (\d{1,2}), (\d{4})/); // Sep 10, 2026, 6:02:11 PM (Strava)
  if (m) {
    const mon = MONTHS[m[1].toLowerCase().slice(0, 4)] ?? MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (mon) return `${m[3]}-${pad(String(mon))}-${pad(m[2])}`;
  }
  m = s.match(/^(\d{1,2}) ([A-Za-zА-Яа-яё]+)\.? (\d{4})/); // 10 сен 2026
  if (m) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (mon) return `${m[3]}-${pad(String(mon))}-${pad(m[1])}`;
  }
  return null;
}

/** Минуты из «5400» (секунды у Strava/Garmin), «1:30:00», «45:00», «45» (минуты),
 *  «45 мин». Число без единиц больше 300 считается секундами: тренировок дольше
 *  пяти часов не бывает, а Strava пишет ровно секунды. */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(',', '.');
  if (!s) return null;
  let m = s.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (m) return Math.round(+m[1] * 60 + +m[2] + +m[3] / 60);
  m = s.match(/^(\d{1,3}):(\d{2})$/);
  if (m) return Math.round(+m[1] + +m[2] / 60);
  m = s.match(/^(\d+(?:\.\d+)?)\s*(мин|min|m)?$/);
  if (m) {
    const n = +m[1];
    if (m[2]) return Math.round(n);
    return n > 300 ? Math.round(n / 60) : Math.round(n);
  }
  m = s.match(/^(\d+(?:\.\d+)?)\s*(ч|h|hr|hours?)$/);
  if (m) return Math.round(+m[1] * 60);
  return null;
}

/** Километры из «5.2», «5,2», «5200» (метры у Strava-экспорта в новых
 *  колонках), «5.2 km». Больше 200 — метры. */
export function parseDistance(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(',', '.');
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(км|km|m|м)?$/);
  if (!m) return null;
  const n = +m[1];
  if (m[2] === 'm' || m[2] === 'м') return Math.round(n / 10) / 100;
  return n > 200 ? Math.round(n / 10) / 100 : Math.round(n * 100) / 100;
}

const TYPE_WORDS: [WorkoutType, string[]][] = [
  ['run', ['run', 'бег', 'jog', 'пробежка', 'trail']],
  ['walk', ['walk', 'hike', 'ходьба', 'прогулка', 'поход']],
  ['bike', ['ride', 'bike', 'cycl', 'вело']],
  ['swim', ['swim', 'плав']],
  ['boxing', ['box', 'бокс', 'kickbox', 'mma']],
  ['kettlebell', ['kettle', 'гир']],
  ['strength', ['weight', 'strength', 'сил', 'gym', 'crossfit', 'workout', 'тренировка', 'зал']],
  ['stretch', ['yoga', 'stretch', 'растяж', 'йог', 'pilates', 'пилатес']],
];

export function parseType(raw: string): WorkoutType {
  const s = raw.trim().toLowerCase();
  for (const [type, words] of TYPE_WORDS) {
    if (words.some((w) => s.includes(w))) return type;
  }
  return 'other';
}

/** Разобрать текст CSV в список тренировок. Первая строка — заголовок. */
export function parseWorkoutsCsv(text: string): ParseResult {
  const table = splitCsv(text.replace(/^\uFEFF/, ''));
  if (table.length < 2) return { rows: [], skipped: 0 };
  const header = table[0];
  const ci = {
    date: findColumn(header, COLUMNS.date),
    type: findColumn(header, COLUMNS.type),
    duration: findColumn(header, COLUMNS.duration),
    distance: findColumn(header, COLUMNS.distance),
    note: findColumn(header, COLUMNS.note),
  };
  if (ci.date < 0 || ci.duration < 0) return { rows: [], skipped: table.length - 1 };
  const rows: ParsedWorkout[] = [];
  let skipped = 0;
  for (const cells of table.slice(1)) {
    const date = parseDate(cells[ci.date] ?? '');
    const minutes = parseDuration(cells[ci.duration] ?? '');
    if (!date || minutes === null || minutes <= 0) {
      skipped++;
      continue;
    }
    const type = ci.type >= 0 ? parseType(cells[ci.type] ?? '') : 'other';
    const distanceKm = ci.distance >= 0 ? parseDistance(cells[ci.distance] ?? '') : null;
    const note = ci.note >= 0 && ci.note !== ci.type ? (cells[ci.note] ?? '').trim() : '';
    rows.push({ date, type, minutes, distanceKm: distanceKm && distanceKm > 0 ? distanceKm : null, note });
  }
  return { rows, skipped };
}

type DupKey = Pick<Workout, 'date' | 'type' | 'minutes' | 'distanceKm'>;
const dupKey = (w: DupKey) =>
  `${w.date}|${w.type}|${w.minutes}|${w.distanceKm == null ? '' : Math.round(w.distanceKm)}`;

/** Убрать из разобранного то, что уже есть: та же дата, вид, минуты и
 *  дистанция до целого км (две пробежки одного дня по 30 минут — утро 5 км и
 *  вечер 7 км — разные записи). Файл выгрузки обычно содержит всё с начала
 *  времён, а импортируют его не раз. В existing передавать ВСЮ таблицу, с
 *  удалёнными: иначе удалённая рукой запись воскресает при следующем импорте. */
export function withoutDuplicates(rows: ParsedWorkout[], existing: DupKey[]): ParsedWorkout[] {
  const seen = new Set(existing.map(dupKey));
  const out: ParsedWorkout[] = [];
  for (const r of rows) {
    const key = dupKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function pad(s: string): string {
  return s.padStart(2, '0');
}
