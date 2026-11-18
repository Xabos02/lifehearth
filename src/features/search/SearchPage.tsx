import { useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Bell, MessagesSquare, SearchX } from 'lucide-react';
// Иконки разделов берём из РЕЕСТРА, а не держим свой список.
//
// Экран поиска рисовал их собственным набором на lucide, а таб-бар под ним —
// уже своими глифами. Один и тот же раздел оказывался в кадре двумя разными
// рисунками одновременно: «Заметки» сверху блокнотом со спиралью, «Заметки»
// внизу листом с загнутым уголком. Ровно тот шум, ради устранения которого
// набор и рисовался, только собранный на одном экране.
//
// Реестр — единственный источник: сменится глиф раздела, сменится везде.
import { SECTION_BY_ID } from '../../lib/sections';
import { GCheck, GSearch as Search } from '../../components/ui/glyphs';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { SearchField } from '../../components/ui/Input';
import { Haptic } from '../../components/ui/Haptic';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { searchMessages } from '../../lib/family/searchMessages';
import { t } from '../../lib/i18n';
import { formatRu, toKey } from '../../lib/dates';
import { ICON } from '../../components/ui/icons';

const PER_SECTION = 8;

/** HTML заметки → плоский текст для поиска и контекста (теги убираем regex-ом).
 *
 *  Пустой аргумент допустим: запись без content приезжает синком с устройства
 *  другой версии или из восстановленной копии, и падать всем поиском из-за
 *  одной такой заметки нельзя. */
function htmlToText(html: string | null | undefined): string {
  // Сущности декодируем через textarea, а не оставляем как есть: в заметке с
  // таблицей или двойным пробелом стоят &nbsp;, и без декодирования они
  // попадали В ТЕКСТ — «Джаммеры&nbsp;&nbsp;5 шт» и в стоге поиска, и в
  // показанном куске ответа.
  const ta = document.createElement('textarea');
  ta.innerHTML = (html ?? '').replace(/<[^>]+>/g, ' ');
  // \s здесь включает неразрывный пробел — для поиска это и нужно: человек
  // ищет «шт 5», а между словами стоит зазор колонок.
  return ta.value.replace(/\s+/g, ' ').trim();
}

interface Hit {
  id: string;
  to: string;
  title: string;
  context: string;
  /** Выполненная задача: галочка и зачёркнутый заголовок, как в макете. */
  done?: boolean;
}

/** Где в тексте совпадение. Нормализация (регистр, «ё» → «е») длину строки
 *  не меняет, поэтому индексы нормализованного текста годятся и для исходного. */
function findAt(text: string, q: string): number {
  return q ? text.toLowerCase().replace(/ё/g, 'е').indexOf(q) : -1;
}

/** Кусок контекста вокруг совпадения: найденное слово в длинной заметке
 *  иначе пряталось за обрезкой строки, и было непонятно, почему она нашлась. */
function snippet(text: string, q: string, radius = 40): string {
  const at = findAt(text, q);
  if (at < 0 || text.length <= radius * 2) return text;
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + q.length + radius);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
}

/** Подсветка всех вхождений запроса. */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts: ReactNode[] = [];
  const hay = text.toLowerCase().replace(/ё/g, 'е');
  let i = 0;
  for (let at = hay.indexOf(q); at >= 0; at = hay.indexOf(q, at + q.length)) {
    if (at > i) parts.push(text.slice(i, at));
    parts.push(
      // Подложка акцента — токен, текст на ней — основным цветом (§1.2, §1.7):
      // унаследованный серый на золоте давал 2.8–3.8:1.
      <mark key={at} className="rounded-sm bg-lh-accent-dim text-lh-text-primary">
        {text.slice(at, at + q.length)}
      </mark>,
    );
    i = at + q.length;
  }
  if (i < text.length) parts.push(text.slice(i));
  return <>{parts}</>;
}

interface SectionResult {
  key: string;
  label: string;
  icon: LucideIcon;
  hits: Hit[];
  total: number;
}

function Row({ icon: Icon, hit, q }: { icon: LucideIcon; hit: Hit; q: string }) {
  return (
    <Link to={hit.to} className="flex items-start gap-3 px-4 py-3 active:bg-lh-surface-2">
      <span
        aria-hidden="true"
        className={`flex size-8 shrink-0 items-center justify-center rounded-lg bg-lh-surface-2 ${hit.done ? 'text-success' : 'text-lh-accent'}`}
      >
        {hit.done ? <GCheck size={ICON.action} /> : <Icon size={ICON.action} />}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={`line-clamp-2 text-base leading-snug ${hit.done ? 'text-lh-text-secondary line-through decoration-lh-text-secondary/60' : ''}`}
        >
          {hit.title ? <Highlight text={hit.title} q={q} /> : t('Без названия')}
        </p>
        {hit.context && (
          <p className="mt-0.5 line-clamp-2 text-sm leading-snug text-lh-text-secondary">
            <Highlight text={snippet(hit.context, q)} q={q} />
          </p>
        )}
      </div>
    </Link>
  );
}

// Запрос живёт в памяти модуля до перезагрузки страницы — как «Скрыть» у
// строки защиты данных и подсказки «скрыть пока» (useHint). Переход к
// найденному размонтирует экран, и «назад» возвращал пустое поле —
// следующий результат приходилось искать заново (прогон 13–17.09). Память
// модуля переживает и «назад», и новый вход из шапки «Сегодня»: у
// приложения, установленного на экран «Домой», кнопки «назад» браузера нет.
//
// В адрес запрос не пишем. Первая починка писала его туда на каждую букву
// (history.replaceState), а WebKit разрешает не больше 100 таких вызовов за
// 10 секунд: дальше SecurityError, и «назад» возвращал обрезанный запрос.
let lastQuery = '';

export function SearchPage() {
  const [query, setQueryState] = useState(lastQuery);
  // Фильтр-чип «Всё / Задачи · 5 / …»: при выбранном разделе показываем его
  // целиком, без обрезки в PER_SECTION.
  const [filter, setFilter] = useState<string>('all');
  const setQuery = (v: string) => {
    lastQuery = v;
    setQueryState(v);
  };
  // «ё» и «е» — одна буква, как в поиске по чату: «колеса» должно находить
  // «колёса». Нормализуем и запрос, и текст.
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
  const q = norm(query.trim());

  // Читаем базу ТОЛЬКО когда есть что искать.
  //
  // Раньше девять запросов выполнялись при открытии экрана и висели живыми
  // подписками всё время, пока он открыт. Среди них — вся переписка семьи
  // вместе с фотографиями, голосовыми и кусками файлов (они лежат в тех же
  // строках) и все задачи с их снимками. Экран открывается с главной одним
  // тапом, и каждое входящее сообщение перечитывало всё заново.
  //
  // Короткий запрос тоже не читаем: по одной букве находится вся база, и
  // пользы в таком ответе нет.
  const data = useLiveQuery(async () => {
    if (q.length < 2) return null;
    const [tasks, notes, goals, places, learning, energy, expenses, reminders, families] =
      await Promise.all([
        db.tasks.toArray(),
        db.notes.toArray(),
        db.goals.toArray(),
        db.placeItems.toArray(),
        db.learningItems.toArray(),
        db.energyItems.toArray(),
        db.expenseItems.toArray(),
        db.reminderItems.toArray(),
        db.family.toArray(),
      ]);
    // Переписку ищем тем же способом, что и внутри чата: по хвосту истории
    // и по составному индексу, а не полным чтением таблицы.
    const chat = (
      await Promise.all(families.map((f) => searchMessages(f.familyId, query)))
    ).flat();
    return { tasks, notes, goals, places, learning, energy, expenses, reminders, chat };
  }, [q, query]);

  const sections = useMemo<SectionResult[]>(() => {
    if (!q || !data) return [];
    const { tasks, notes, goals, places, learning, energy, expenses, reminders } = data;

    const build = (
      key: string,
      label: string,
      icon: LucideIcon,
      all: Hit[],
    ): SectionResult => ({ key, label, icon, hits: all, total: all.length });

    const taskHits: Hit[] = alive(tasks ?? [])
      .filter((task) => norm(`${task.title}\n${task.notes}`).includes(q))
      .map((task) => ({
        id: task.id,
        to: '/tasks',
        title: task.title,
        done: Boolean(task.completedAt),
        // Совпало в описании — показываем его кусок; иначе — когда: срок или
        // день выполнения, по нему задачу и узнают.
        context:
          findAt(task.notes ?? '', q) >= 0
            ? task.notes
            : task.completedAt
              ? t('Выполнено {date}', { date: formatRu(toKey(new Date(task.completedAt))) })
              : task.dueDate
                ? t('до {date}', { date: formatRu(task.dueDate) })
                : '',
      }));

    const noteHits: Hit[] = alive(notes ?? [])
      .map((n) => ({ note: n, text: htmlToText(n.content) }))
      .filter(({ note, text }) => norm(`${note.title}\n${text}`).includes(q))
      .map(({ note, text }) => ({
        id: note.id,
        to: `/notes/${note.id}`,
        title: note.title || text.split(' ').slice(0, 6).join(' '),
        context: text,
      }));

    const goalHits: Hit[] = alive(goals ?? [])
      .filter((g) => norm(`${g.title}\n${g.description}`).includes(q))
      .map((g) => ({ id: g.id, to: `/goals/${g.id}`, title: g.title, context: g.description }));

    const placeHits: Hit[] = alive(places ?? [])
      .filter((p) => norm(`${p.title}\n${p.description}\n${p.source}`).includes(q))
      .map((p) => ({ id: p.id, to: `/more/places#${p.id}`, title: p.title, context: p.description }));

    const learningHits: Hit[] = alive(learning ?? [])
      .filter((l) => norm(`${l.title}\n${l.author}`).includes(q))
      .map((l) => ({ id: l.id, to: '/more/learning', title: l.title, context: l.author }));

    const energyHits: Hit[] = alive(energy ?? [])
      .filter((e) => norm(`${e.title}\n${e.description}`).includes(q))
      .map((e) => ({ id: e.id, to: '/more/energy', title: e.title, context: e.description }));

    const expenseHits: Hit[] = alive(expenses ?? [])
      .filter((x) => norm(`${x.title}\n${x.category}`).includes(q))
      .map((x) => ({ id: x.id, to: '/more/finance', title: x.title, context: t(x.category) }));

    // Чат append-only и без другой навигации, кроме скролла, — поиск обязан
    // его видеть. Отбор (удалённые, системные, регистр, «ё») уже сделан
    // searchMessages: он же используется внутри самого чата, и расхождения
    // между «нашлось в поиске» и «нашлось в чате» быть не должно.
    const chatHits: Hit[] = data.chat
      .sort((a, b) => (b.message.seq ?? 0) - (a.message.seq ?? 0))
      .map(({ message: m }) => ({
        id: m.clientMsgId,
        to: `/more/family?g=${m.familyId}`,
        title: m.text || m.file?.name || '',
        context: new Date(m.createdAt).toLocaleDateString('ru-RU'),
      }));

    const reminderHits: Hit[] = alive(reminders ?? [])
      .filter((r) => norm(r.text).includes(q))
      .map((r) => ({ id: r.id, to: '/', title: r.text, context: '' }));

    return [
      build('tasks', t('Задачи'), SECTION_BY_ID.get('tasks')!.icon, taskHits),
      build('notes', t('Заметки'), SECTION_BY_ID.get('notes')!.icon, noteHits),
      build('goals', t('Цели'), SECTION_BY_ID.get('goals')!.icon, goalHits),
      build('reminders', t('Напоминания'), Bell, reminderHits),
      build('family', t('Семейный чат'), MessagesSquare, chatHits),
      build('places', t('Места'), SECTION_BY_ID.get('places')!.icon, placeHits),
      build('learning', t('Обучение'), SECTION_BY_ID.get('learning')!.icon, learningHits),
      build('energy', t('Энергия'), SECTION_BY_ID.get('energy')!.icon, energyHits),
      build('expenses', t('Финансы'), SECTION_BY_ID.get('finance')!.icon, expenseHits),
    ].filter((s) => s.total > 0);
  }, [q, data]);

  const active = sections.some((s) => s.key === filter) ? filter : 'all';
  const shown = active === 'all' ? sections : sections.filter((s) => s.key === active);
  const totalAll = sections.reduce((n, s) => n + s.total, 0);
  const chips = [{ key: 'all', label: t('Всё'), total: totalAll }, ...sections];

  return (
    <Screen title={t('Поиск')} backTo="/">
      <SearchField
        autoFocus
        value={query}
        onChange={setQuery}
        placeholder={t('Искать везде…')}
        className="mb-1"
      />

      {/* Чипы разделов — только когда есть больше одного раздела с
          результатами: один чип «Всё» рядом с одним разделом ничего не
          отбирает. */}
      {sections.length > 1 && (
        // py-1: overflow-x-auto режет и по вертикали, а рамка фокуса
        // (outline 2px + offset 2px, index.css) выступает за кнопку на 4px —
        // без отступа от неё оставались две боковые палочки. -my-1 возвращает
        // строку на прежнее место; зазор до списка ниже даёт его mt-3.
        <div className="-mx-4 -my-1 flex gap-2 overflow-x-auto px-4 py-1 [scrollbar-width:none]">
          {chips.map((c) => {
            const on = c.key === active;
            return (
              <button
                key={c.key}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(c.key)}
                className="flex h-11 shrink-0 items-center active:scale-95"
              >
                <span
                  className={`flex h-8 items-center rounded-full px-3 text-sm tabular-nums ${
                    on
                      ? 'bg-lh-text-primary font-semibold text-lh-bg'
                      : 'border border-lh-border text-lh-text-secondary'
                  }`}
                >
                  {c.label} · {c.total}
                </span>
                {/* Чип выбора щёлкает (PROTOCOL §6.4); выбранный — нет. */}
                <Haptic off={on} />
              </button>
            );
          })}
        </div>
      )}

      {!q ? (
        <EmptyState
          icon={Search}
          title={t('Поиск по всему')}
          hint={t('Задачи, заметки, цели, финансы и обучение — всё найдётся здесь')}
        />
      ) : sections.length === 0 ? (
        <EmptyState icon={SearchX} title={t('Ничего не найдено')} hint={t('Попробуйте другой запрос')} />
      ) : (
        <div className="mt-3 space-y-5">
          {shown.map((s) => {
            const hits = active === 'all' ? s.hits.slice(0, PER_SECTION) : s.hits;
            return (
              <section key={s.key}>
                <h2 className="mb-2 px-1 lh-section">
                  {s.label} · {s.total}
                </h2>
                <div className="card divide-y divide-lh-border">
                  {hits.map((hit) => (
                    <Row key={hit.id} icon={s.icon} hit={hit} q={q} />
                  ))}
                  {s.total > hits.length && (
                    <button
                      type="button"
                      onClick={() => setFilter(s.key)}
                      className="flex h-11 w-full items-center px-4 text-left text-sm text-lh-accent active:bg-lh-surface-2"
                    >
                      {t('и ещё {n}', { n: s.total - hits.length })}
                    </button>
                  )}
                </div>
              </section>
            );
          })}
          <p className="px-1 pb-2 text-center text-xs text-lh-text-secondary">
            {t('Ищем в задачах, заметках, целях, напоминаниях, чате, местах, обучении, энергии и финансах')}
          </p>
        </div>
      )}
    </Screen>
  );
}
