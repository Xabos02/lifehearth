import { Link } from 'react-router';
import { Compass } from 'lucide-react';
import { Screen } from '../components/layout/Screen';
import { t } from '../lib/i18n';
import { ICON } from '../components/ui/icons';

/** Неизвестный маршрут: битый дип-линк из пуша или закладка на снесённый
 *  адрес. До этого экрана здесь была немая пустота без шапки и объяснения. */
export function NotFoundPage() {
  return (
    <Screen title={t('Не найдено')} backTo="/home">
      <div className="flex flex-col items-center px-4 pt-16 text-center">
        <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-lh-surface-2 text-lh-text-secondary">
          <Compass size={ICON.accent} />
        </div>
        <p className="font-semibold">{t('Такого экрана нет')}</p>
        <p className="mt-1 max-w-[16rem] text-sm text-lh-text-secondary">
          {t('Ссылка устарела или адрес набран с ошибкой.')}
        </p>
        <Link
          to="/"
          className="mt-5 rounded-full bg-lh-accent px-5 py-2.5 text-sm font-semibold text-lh-bg active:opacity-80"
        >
          {t('На «Сегодня»')}
        </Link>
      </div>
    </Screen>
  );
}
