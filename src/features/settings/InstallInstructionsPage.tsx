import type { ReactNode } from 'react';
import {
  CircleCheck,
  Compass,
  Download,
  KeyRound,
  RefreshCw,
  Share,
  ShieldCheck,
  Smartphone,
  SquarePlus,
  Upload,
  type LucideIcon,
} from 'lucide-react';
import { Screen } from '../../components/layout/Screen';
import { InstallLink } from './InstallLink';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import {
  GAlert as TriangleAlert,
} from '../../components/ui/glyphs';

const STEPS: { icon: LucideIcon; text: string }[] = [
  { icon: Compass, text: 'Откройте этот сайт в Safari' },
  { icon: Share, text: 'Нажмите «Поделиться»' },
  { icon: SquarePlus, text: 'Выберите «На экран „Домой“»' },
  { icon: Smartphone, text: 'Откройте LifeHearth с экрана «Домой»' },
];

/** Одна карточка «шаг» с иконкой и текстом. */
function Row({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex gap-3 card p-4">
      <Icon size={ICON.header} className="mt-0.5 shrink-0 text-accent" />
      <p className="min-w-0 text-sm leading-relaxed">{children}</p>
    </div>
  );
}

export function InstallInstructionsPage() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches;

  return (
    <Screen title={t('Установка и данные')} backTo="/more/settings">
      <div className="space-y-6">
        {/* --- Ссылка для установки (всегда доступна) --- */}
        <section className="space-y-2.5">
          <h2 className="text-sm font-semibold text-muted">{t('Ссылка для установки')}</h2>
          <div className="card p-4">
            <p className="mb-3 text-sm leading-relaxed text-muted">
              {t('Открывайте её в Safari, чтобы установить или переустановить приложение, или поделитесь ссылкой. Она всегда есть и в «Настройках».')}
            </p>
            <InstallLink />
          </div>
        </section>

        {/* --- Установка на экран «Домой» --- */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted">{t('Установка на экран «Домой»')}</h2>
          {standalone ? (
            <div className="flex items-center gap-3 rounded-2xl border border-success/40 bg-success/10 p-4 text-success">
              <CircleCheck size={ICON.accent} className="shrink-0" />
              <p className="font-semibold">{t('Приложение установлено ✓')}</p>
            </div>
          ) : (
            <>
              {STEPS.map((step, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 card p-4"
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-bold text-accent">
                    {i + 1}
                  </span>
                  <step.icon size={ICON.header} className="shrink-0 text-accent" />
                  <p className="min-w-0">{t(step.text)}</p>
                </div>
              ))}
              <div className="flex gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4">
                <TriangleAlert size={ICON.header} className="mt-0.5 shrink-0 text-warning" />
                <p className="text-sm leading-relaxed">
                  {t('Данные Safari и установленного приложения хранятся раздельно. Сначала установите приложение, и только потом вводите данные — иначе они останутся во вкладке Safari. Перенести уже введённые данные можно через «Экспорт/Импорт резервной копии» ниже.')}
                </p>
              </div>
            </>
          )}
        </section>

        {/* --- Данные: сохранить перед удалением и вернуть после --- */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted">{t('Данные: сохранить и вернуть')}</h2>

          <div className="flex gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4">
            <TriangleAlert size={ICON.header} className="mt-0.5 shrink-0 text-warning" />
            <p className="text-sm leading-relaxed">
              <span className="font-semibold">{t('Перед удалением или переустановкой сохраните копию.')}</span>{' '}
              {t('Приложение хранит задачи, заметки, цели и финансы на самом устройстве. Если удалить значок, iOS может стереть эти данные. Сохранённая копия возвращает всё обратно — ровно с той же точки.')}
            </p>
          </div>

          <p className="text-sm font-medium text-muted">{t('Как сохранить (любой из способов):')}</p>

          <Row icon={Download}>
            <span className="font-semibold">{t('Резервная копия в файл.')}</span>{' '}
            {t('«Настройки → Копии и восстановление → Копия файлом → Сохранить в файл». Файл сохранится в «Файлы» (или iCloud Drive) и переживёт удаление приложения.')}
          </Row>
          <Row icon={ShieldCheck}>
            <span className="font-semibold">{t('Синхронизация (облако).')}</span>{' '}
            {t('«Настройки → Синхронизация → Включить синхронизацию». Зашифрованная копия ложится в облако под вашим ключом. Сразу после включения приложение попросит сохранить ключ восстановления — сохраните: без него облако не вернуть ничем.')}
          </Row>

          <p className="text-sm font-medium text-muted">{t('Как вернуть после переустановки:')}</p>

          <Row icon={Upload}>
            <span className="font-semibold">{t('Из файла.')}</span>{' '}
            {t('Откройте приложение → «Настройки → Копии и восстановление → Копия файлом → Восстановить» → выберите сохранённый файл.')}
          </Row>
          <Row icon={KeyRound}>
            <span className="font-semibold">{t('Из синхронизации.')}</span>{' '}
            {t('«Настройки → Синхронизация → У меня уже есть данные — подключить по ключу» → вставьте сохранённый ключ или отсканируйте QR со второго устройства.')}
          </Row>
          <Row icon={RefreshCw}>
            {t('После восстановления данные снова на месте, а если оставить синхронизацию включённой — новые изменения будут сами уходить в облако.')}
          </Row>
        </section>
      </div>
    </Screen>
  );
}
