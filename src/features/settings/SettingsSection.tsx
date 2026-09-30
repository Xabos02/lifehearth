import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router';
import { GChevronRight as ChevronRight } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';

/** Группа настроек: рубрика сверху, карточка со строками, сноска снизу.
 *
 *  Сноска — не украшение, а место, куда переехали объяснения. Раньше они жили
 *  ВНУТРИ строк отдельными абзацами, и треть длины всего экрана (3139px при
 *  экране 736px) приходилась на них: «Включить уведомления» с пояснением
 *  занимало 177px, предупреждение про браузер — 144px, состав резервной
 *  копии — 144px, описание раздела «ИИ» — 187px. Строка настройки — место для
 *  названия и значения; объяснение читают один раз, и его место под группой,
 *  мелким текстом, как в системных настройках телефона. */
export function Section({
  title,
  footnote,
  children,
}: {
  title: string;
  footnote?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="lh-section mb-2 px-1">{title}</h2>
      {children}
      {footnote && <p className="mt-2 px-1 text-xs leading-snug text-lh-text-secondary">{footnote}</p>}
    </section>
  );
}

/** Строка настройки: название слева, значение или контрол справа.
 *
 *  Одна форма на весь экран — раньше строки были кто во что горазд: где-то
 *  заголовок с описанием, где-то абзац, где-то кнопка во всю ширину. min-h-11
 *  держит зону касания. */
export function Row({
  icon: Icon,
  label,
  value,
  children,
}: {
  icon?: ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  /** Короткое значение справа — «Тёмная», «Русский», «никогда». */
  value?: ReactNode;
  /** Контрол вместо значения: переключатель, селект, кнопка. */
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-2 border-t border-lh-border px-4 py-2.5 first:border-t-0">
      {Icon && <Icon size={ICON.header} className="shrink-0 text-lh-text-secondary" />}
      <span className="flex-1">{label}</span>
      {value != null && <span className="shrink-0 text-sm text-lh-text-secondary">{value}</span>}
      {children}
    </div>
  );
}


/** Строка-ссылка: то же, что Row, но ведёт на другой экран.
 *
 *  Шеврон справа — единственный признак, по которому строку отличают от
 *  настройки со значением, поэтому он обязателен и всегда на одном месте. */
export function LinkRow({
  icon: Icon,
  label,
  to,
  value,
}: {
  icon?: ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  to: string;
  value?: ReactNode;
}) {
  return (
    <Link
      to={to}
      className="flex min-h-11 items-center gap-2 border-t border-lh-border px-4 py-2.5 first:border-t-0 active:bg-lh-surface-2"
    >
      {Icon && <Icon size={ICON.header} className="shrink-0 text-lh-text-secondary" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value != null && <span className="shrink-0 text-sm text-lh-text-secondary">{value}</span>}
      <ChevronRight size={ICON.action} className="shrink-0 text-lh-text-secondary" />
    </Link>
  );
}

/** Строка-кнопка: вся строка — цель нажатия, как у LinkRow, но действие
 *  происходит здесь же (открыть окно, сбросить, повторить). Шеврон не ставим —
 *  он обещал бы переход на другой экран. */
export function ButtonRow({
  icon: Icon,
  label,
  action,
  onClick,
}: {
  icon?: ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  /** Что произойдёт — короткий глагол справа, вместо шеврона. */
  action: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 w-full items-center gap-2 border-t border-lh-border px-4 py-2.5 text-left first:border-t-0 active:bg-lh-surface-2"
    >
      {Icon && <Icon size={ICON.header} className="shrink-0 text-lh-text-secondary" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-sm font-semibold text-lh-accent">{action}</span>
    </button>
  );
}
