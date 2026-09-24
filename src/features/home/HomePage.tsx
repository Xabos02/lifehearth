import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { User } from 'lucide-react';
import {
  GChevronDown as ChevronDown,
  GChevronRight as ChevronRight,
  GCloud as Cloud,
  GCloudOff as CloudOff,
  GSettings as SettingsIcon,
} from '../../components/ui/glyphs';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { Screen } from '../../components/layout/Screen';
import { db } from '../../db/db';
import { isBackupDue } from '../../db/backup';
import { alive } from '../../db/repo';
import { useNavLayout } from '../../hooks/useNavLayout';
import { formatRu } from '../../lib/dates';
import { ageFrom, yearsLabel } from '../../lib/profile';
import { HOME_VISIBLE_STEP, SECTION_BY_ID } from '../../lib/sections';
import { getLang, t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';

const BACKUP_STALE_MS = 7 * 24 * 60 * 60 * 1000;

interface MenuCardProps {
  to: string;
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  subtitleWarning?: boolean;
  badge?: boolean;
}

function MenuCard({ to, icon: Icon, title, subtitle, subtitleWarning, badge }: MenuCardProps) {
  return (
    <Link to={to} className="flex items-stretch gap-3 pl-4 active:bg-surface-2">
      <div className="relative my-3 flex size-10 shrink-0 items-center justify-center rounded-xl tile-accent text-accent">
        <Icon size={ICON.header} />
        {badge && (
          <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-warning" />
        )}
      </div>
      {/* Разделитель живёт ЗДЕСЬ, а не на всей строке: линия во всю ширину
          режет строку под знаком, а начатая от текстовой колонки читается как
          в системных списках. Первой строке границу снимает родитель. */}
      <div className="flex min-w-0 flex-1 items-center gap-3 border-t border-hairline py-3 pr-4">
        {/* min-w-0 обязателен: иначе длинная подпись не даёт колонке сжаться и
            выдавливает стрелку за край карточки. */}
        <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {/* Две строки вместо многоточия: на 320px под подпись остаётся 158px,
            а «Общие задачи, чат и звонки» требует 299 — обрезка съедала
            половину фразы. Карточка от второй строки подрастает, но список
            всё равно вертикальный, и читаемость важнее ровной высоты. */}
        {subtitle && (
          <p
            className={`line-clamp-2 text-sm leading-snug ${
              subtitleWarning ? 'text-warning' : 'text-muted'
            }`}
          >
            {subtitle}
          </p>
        )}
        </div>
        <ChevronRight size={ICON.header} className="shrink-0 text-muted" />
      </div>
    </Link>
  );
}

/** Карточка профиля. Ведёт на экран редактирования; пока ничего не заполнено —
 *  зовёт заполнить, а не показывает пустые поля. */
function ProfileCard() {
  const settings = useLiveQuery(() => db.settings.get('app'), []);
  const p = settings?.profile;
  const hasAny = Boolean(p?.name || p?.avatar || p?.heightCm || p?.weightKg);

  // Возраст, а не дата рождения: «28 лет» отвечает на вопрос, который человек
  // задаёт себе, глядя на карточку, а «29 июня 1998» заставляет считать в уме.
  // Порядок тот же, что в шапке самого профиля, — карточка и экран за ней
  // должны говорить одно и то же одними словами.
  const age = ageFrom(p?.birthDate);
  const facts = [
    age != null ? yearsLabel(age) : null,
    p?.heightCm ? t('{n}\u00A0см', { n: p.heightCm }) : null,
    p?.weightKg
      ? t('{n}\u00A0кг', { n: getLang() === 'en' ? String(p.weightKg) : String(p.weightKg).replace('.', ',') })
      : null,
  ].filter(Boolean);

  return (
    <Link
      to="/home/profile"
      className="flex items-center gap-3.5 card p-4 active:opacity-80"
    >
      {p?.avatar ? (
        <img
          src={p.avatar}
          alt=""
          className="size-14 shrink-0 rounded-full object-cover"
          width={56}
          height={56}
        />
      ) : (
        <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
          <User size={ICON.accent} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className={`text-lg font-semibold ${p?.name?.trim() ? 'truncate' : 'leading-tight'}`}>
          {p?.name?.trim() || (hasAny ? t('Без имени') : t('Заполнить профиль'))}
        </p>
        <p className="text-sm leading-snug text-muted">
          {facts.length > 0 ? facts.join(' · ') : t('Имя, фото, рост и вес')}
        </p>
      </div>
      <ChevronRight size={ICON.header} className="shrink-0 text-muted" />
    </Link>
  );
}

/** Состояние данных: синхронизация и свежесть копии.
 *
 *  Стоит на «Главной», а не в настройках, по одной причине: это единственное
 *  место, где человек узнаёт, что его данные под угрозой, не заходя специально
 *  в настройки. Потеря данных — самая частая претензия к приложениям этой
 *  категории, и она почти всегда следует из того, что человек не знал. */
function DataStatusCard() {
  const syncCfg = useLiveQuery(() => db.sync.get('config').then((c) => c ?? null), []);
  // Date.now() внутри запроса, а не в рендере: рендер обязан быть чистым, а
  // здесь значение к тому же пересчитывается при каждом изменении настроек —
  // значит после копии предупреждение гаснет сразу.
  const status = useLiveQuery(async () => {
    const s = await db.settings.get('app');
    const last = s?.lastBackupAt ?? null;
    return {
      last,
      stale: !last || Date.now() - new Date(last).getTime() > BACKUP_STALE_MS,
    };
  }, []);
  if (syncCfg === undefined || status === undefined) return null;

  const syncOn = Boolean(syncCfg?.enabled);
  const { last, stale } = status;

  return (
    <Link
      to="/more/settings"
      className="flex items-center gap-3 card p-4 active:opacity-80"
    >
      <div
        className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
          syncOn ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
        }`}
      >
        {syncOn ? <Cloud size={ICON.header} /> : <CloudOff size={ICON.header} />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{syncOn ? t('Данные синхронизируются') : t('Только на этом устройстве')}</p>
        {/* Без truncate по той же причине, что и в MenuCard: «Копию ещё не
            делали» на 320px не влезает в 158px и обрывалось на «не дел…» —
            ровно то предупреждение, которое обязано читаться целиком. */}
        <p className={`text-sm leading-snug ${stale ? 'text-warning' : 'text-muted'}`}>
          {last ? t('Копия: {date}', { date: formatRu(last.slice(0, 10), 'd MMMM') }) : t('Резервную копию ещё не делали')}
        </p>
      </div>
      <ChevronRight size={ICON.header} className="shrink-0 text-muted" />
    </Link>
  );
}

export function HomePage() {
  // Список разделов и их порядок — из раскладки «под себя»: то, что вынесено в
  // нижнюю панель или спрятано, здесь не повторяется.
  const { more } = useNavLayout();
  // Показываем не всё сразу: длинный список плиток на «Главной» выглядит
  // перегруженным, а порядок и так задан приоритетом человека (см. «Настроить
  // разделы») — первые HOME_VISIBLE_STEP и есть самые ходовые для него.
  // Остальные — за «Показать ещё», по столько же за раз.
  const [visibleCount, setVisibleCount] = useState(HOME_VISIBLE_STEP);
  const learning = useLiveQuery(
    () => db.learningItems.where('status').equals('inProgress').toArray(),
    [],
  );
  // Date.now() внутри запроса, а не в рендере: пересчитывается при изменении
  // настроек, поэтому бейдж гаснет сразу после копии. Правило одно с точкой на
  // вкладке (isBackupDue): нечего сохранять — не зовём.
  const backupDue = useLiveQuery(() => isBackupDue(), []) ?? false;

  const learningCount = alive(learning ?? []).length;
  // Настройки показываем отдельной карточкой внизу, поэтому из общего списка
  // убираем — иначе они встретятся дважды.
  const sections = more.filter((s) => s.id !== 'settings');
  const settingsSection = SECTION_BY_ID.get('settings');

  return (
    <Screen title={t('Главная')}>
      <div className="space-y-5">
        <div className="space-y-3">
          <ProfileCard />
          <DataStatusCard />
        </div>

        {sections.length > 0 && (
          <section>
            <h2 className="mb-1.5 px-1 text-sm font-semibold text-muted">{t('Разделы')}</h2>
            {/* Один контейнер вместо десяти карточек: у каждой была своя
                рамка и своя тень, а высоты в одном ряду расходились на 20px
                (82 / 95 / 103) — список читался как набор плиток, а не как
                список. Разделитель идёт от текстовой колонки. */}
            <div className="card overflow-hidden [&>a:first-child>div:last-child]:border-t-0">
              {sections.slice(0, visibleCount).map((s) => (
                <MenuCard
                  key={s.id}
                  to={s.to}
                  icon={s.icon}
                  title={t(s.label)}
                  subtitle={s.id === 'learning' ? t('{n} в процессе', { n: learningCount }) : s.subtitle && t(s.subtitle)}
                />
              ))}
            </div>
            {sections.length > visibleCount && (
              <button
                type="button"
                onClick={() => setVisibleCount((c) => c + HOME_VISIBLE_STEP)}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border py-3 text-sm font-semibold text-muted active:opacity-70"
              >
                {t('Показать ещё {n}', { n: Math.min(HOME_VISIBLE_STEP, sections.length - visibleCount) })}
                <ChevronDown size={ICON.action} />
              </button>
            )}
          </section>
        )}

        {settingsSection && (
          <section className="card overflow-hidden [&>a>div:last-child]:border-t-0">
            <MenuCard
              to={settingsSection.to}
              icon={SettingsIcon}
              title={t(settingsSection.label)}
              subtitle={backupDue ? t('Пора сделать резервную копию') : settingsSection.subtitle && t(settingsSection.subtitle)}
              subtitleWarning={backupDue}
              badge={backupDue}
            />
          </section>
        )}
      </div>
    </Screen>
  );
}
