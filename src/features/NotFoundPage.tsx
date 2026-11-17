import { Link } from 'react-router';
import { Compass, Search, Sun } from 'lucide-react';
import { Screen } from '../components/layout/Screen';
import { t } from '../lib/i18n';
import { ICON } from '../components/ui/icons';

/** Неизвестный маршрут: битый дип-линк из пуша или закладка на снесённый
 *  адрес. До этого экрана здесь была немая пустота без шапки и объяснения. */
export function NotFoundPage() {
  return (
    <Screen title={t('Не найдено')} backTo="/home">
      <div className="flex flex-col items-center px-4 pt-12 text-center">
        <div className="grid size-20 place-items-center rounded-3xl border border-lh-border bg-lh-surface text-lh-accent">
          <Compass size={ICON.hero} />
        </div>
        <h2 className="mt-8 text-2xl font-light leading-tight">{t('Такого экрана нет')}</h2>
        <p className="mt-3 max-w-[18rem] text-sm leading-relaxed text-lh-text-secondary">
          {t('Ссылка устарела или адрес набран с ошибкой.')}
        </p>
        <Link
          to="/"
          className="mt-8 flex h-13 items-center gap-2 rounded-xl bg-lh-accent px-8 text-base font-semibold text-lh-bg active:opacity-80"
        >
          <Sun size={ICON.inline} />
          {t('На «Сегодня»')}
        </Link>
        <Link to="/search" className="mt-2 flex h-11 items-center gap-2 px-4 text-sm text-lh-accent active:opacity-60">
          <Search size={ICON.inline} />
          {t('Найти в приложении')}
        </Link>
      </div>
    </Screen>
  );
}
