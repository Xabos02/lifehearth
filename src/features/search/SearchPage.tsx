import { useMemo, useState } from 'react';
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
import {
  GSearch as Search,
} from '../../components/ui/glyphs';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { Screen } from '../../components/layout/Screen';
import { EmptyState } from '../../components/ui/EmptyState';
import { SearchField } from '../../components/ui/Input';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { searchMessages } from '../../lib/family/searchMessages';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

const PER_SECTION = 8;

/** HTML заметки → плоский текст для поиска и контекста (теги убираем regex-ом).
 *
 *  Пустой аргумент допустим: запись без content приезжает синком с устройства
 *  другой версии или из восстановленной копии, и падать всем поиском из-за
 *  одной такой заметки нельзя. */
function htmlToText(html: string | null | undefined): string {
  return (html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Hit {
  id: string;
  to: string;
  title: string;
  context: string;
}

interface SectionResult {
  key: string;
  label: string;
  icon: LucideIcon;
  hits: Hit[];
  total: number;
}

function Row({ icon: Icon, hit }: { icon: LucideIcon; hit: Hit }) {
  return (
    <Link to={hit.to} className="flex items-start gap-3 px-4 py-3 active:opacity-70">
      <Icon size={ICON.base} className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{hit.title || t('Без названия')}</p>
        {hit.context && <p className="truncate text-sm text-muted">{hit.context}</p>}
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
    ): SectionResult => ({ key, label, icon, hits: all.slice(0, PER_SECTION), total: all.length });

    const taskHits: Hit[] = alive(tasks ?? [])
      .filter((task) => norm(`${task.title}\n${task.notes}`).includes(q))
      .map((task) => ({ id: task.id, to: '/tasks', title: task.title, context: task.notes }));

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

  return (
    <Screen title={t('Поиск')} backTo="/">
      <SearchField
        autoFocus
        value={query}
        onChange={setQuery}
        placeholder={t('Искать везде…')}
        className="mb-4"
      />

      {!q ? (
        <EmptyState
          icon={Search}
          title={t('Поиск по всему')}
          hint={t('Задачи, заметки, цели, финансы и обучение — всё найдётся здесь')}
        />
      ) : sections.length === 0 ? (
        <EmptyState icon={SearchX} title={t('Ничего не найдено')} hint={t('Попробуйте другой запрос')} />
      ) : (
        <div className="space-y-5">
          {sections.map((s) => (
            <section key={s.key}>
              <h2 className="mb-1.5 px-1 text-sm font-semibold text-muted">
                {s.label} · {s.total}
              </h2>
              <div className="card divide-y divide-hairline">
                {s.hits.map((hit) => (
                  <Row key={hit.id} icon={s.icon} hit={hit} />
                ))}
              </div>
              {s.total > s.hits.length && (
                <p className="mt-1.5 px-1 text-sm text-muted">
                  {t('и ещё {n}', { n: s.total - s.hits.length })}
                </p>
              )}
            </section>
          ))}
        </div>
      )}
    </Screen>
  );
}
