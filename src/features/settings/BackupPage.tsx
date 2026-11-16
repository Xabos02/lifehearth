import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Download, FileArchive, FolderOpen, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getLang, t } from '../../lib/i18n';
import { Screen } from '../../components/layout/Screen';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { GAlert, GCheck, GChevronRight, GCloud } from '../../components/ui/glyphs';
import { ICON, STROKE_STRONG } from '../../components/ui/icons';
import { useToast } from '../../components/ui/toastContext';
import { useSettings, updateSettings } from '../../hooks/useSettings';
import { db } from '../../db/db';
import { now } from '../../db/repo';
import {
  exportBackup,
  backupFilename,
  validateBackup,
  previewBackup,
  importBackup,
  type BackupFile,
} from '../../db/backup';
import {
  BackupWouldLoseDataError,
  cloudBackupDate,
  type CloudDate,
  pushAccountSnapshot,
  pullAccountSnapshot,
} from '../../lib/cloudBackup';
import { formatRu } from '../../lib/dates';
import { usePersistentStorage } from './usePersistentStorage';
import { ensurePersistentStorage, formatBytes, type StorageState } from '../../lib/storage';
import { TABLE_RU } from './tableNames';
import { Row } from './SettingsSection';
import { Switch } from '../../components/ui/Switch';
import { useConsent } from '../../lib/consent';
import { confirmAction } from '../../components/ui/confirmStore';

/** Карточка сохранности наверху экрана (макет «Копии»). Браузер отказал в
 *  постоянном хранении — данные могут быть стёрты системой, и копия становится
 *  не рекомендацией, а необходимостью: тогда карточка жёлтая и говорит прямо. */
function StorageStatus() {
  const [state, setState] = useState<StorageState | null>(null);
  useEffect(() => {
    void ensurePersistentStorage().then(setState);
  }, []);

  if (!state || state.persisted === undefined) return null;
  const used = state.usage !== undefined ? formatBytes(state.usage) : null;
  const free =
    state.usage !== undefined && state.quota !== undefined && state.quota > state.usage
      ? formatBytes(state.quota - state.usage)
      : null;
  const pct =
    state.usage !== undefined && state.quota ? Math.max(2, Math.min(100, (state.usage / state.quota) * 100)) : null;
  const ok = state.persisted;
  const Icon = ok ? ShieldCheck : ShieldAlert;

  return (
    <section className="card flex gap-3.5 p-4">
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 ${ok ? 'text-success' : 'text-warning'}`}
      >
        <Icon size={ICON.base} strokeWidth={STROKE_STRONG} />
      </span>
      <div className="min-w-0 flex-1">
        {ok ? (
          <>
            <p className="text-base font-semibold">{t('Данные в безопасности')}</p>
            <p className="mt-0.5 text-sm leading-snug text-lh-text-secondary">
              {t('Данные защищены от автоочистки браузером{suffix}.', {
                suffix: used ? t(', занято {used}', { used }) : '',
              })}
            </p>
          </>
        ) : (
          <>
            <p className="text-base font-semibold text-warning">{t('Браузер не гарантирует сохранность данных.')}</p>
            <p className="mt-0.5 text-sm leading-snug text-lh-text-secondary">
              {t(
                'Если открывать приложение как обычную вкладку, Safari стирает данные сайта после недели без визитов. Установите приложение на экран «Домой» и держите копию{suffix}.',
                { suffix: used ? t(' (сейчас занято {used})', { used }) : '' },
              )}
            </p>
          </>
        )}
        {pct != null && used && (
          <div aria-hidden="true">
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-lh-surface-2">
              <i className={`block h-full ${ok ? 'bg-success' : 'bg-warning'}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-lh-text-secondary">
              <span>{used}</span>
              {free && <span>{t('доступно ~ {free}', { free })}</span>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** Плитка значка раздела — нейтральная поверхность, цвет задаёт смысл. */
function Tile({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-10 shrink-0 items-center justify-center rounded-xl bg-lh-surface-2 ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * Копии и восстановление — всё про сохранность данных на одном экране.
 *
 * Раньше это жило двумя секциями («Данные» и «Хранилище») прямо в настройках и
 * занимало 909px из 3139px всей ленты — почти треть, при том что открывают эти
 * вещи раз в жизни: настроил облачную копию, сохранил файл, восстановился
 * после переезда. В списке настроек осталась одна строка со значением («нет
 * копии» / дата), а подробности, предупреждения и кнопки — здесь, где человек
 * и принимает решение.
 */
export function BackupPage() {
  const settings = useSettings();
  const { persisted, usageMb } = usePersistentStorage();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const exportingRef = useRef(false);
  const cloudRef = useRef(false);
  const syncCfg = useLiveQuery(() => db.sync.get('config'), []);
  // Синк включён, но согласия на внешнее нет — облачная копия на паузе
  // (задача 34): не «недоступна» и не «включите синхронизацию» — она включена.
  const consent = useConsent();
  const syncOn = Boolean(syncCfg?.enabled) && consent;
  const paused = Boolean(syncCfg?.enabled) && !consent;
  // undefined — ещё спрашиваем сервер; дальше три РАЗНЫХ состояния: копия
  // есть, копии нет, проверить не удалось. Третье прежде выглядело как второе,
  // и сбой связи читался как «копии нет» — приглашение нажать «Создать» и
  // затереть настоящую копию снимком текущего телефона.
  const [cloudDate, setCloudDate] = useState<CloudDate | undefined>(undefined);
  useEffect(() => {
    if (!syncOn) return;
    let live = true;
    void cloudBackupDate().then((d) => {
      if (live) setCloudDate(d);
    });
    return () => {
      live = false;
    };
  }, [syncOn]);

  async function handleExport() {
    if (exportingRef.current) return;
    exportingRef.current = true;
    try {
      // Отметка о копии — до сборки файла: иначе в самом файле lastBackupAt
      // пустой, и восстановление из свежей копии показывало «никогда».
      await updateSettings({ lastBackupAt: now() });
      const backup = await exportBackup();
      const json = JSON.stringify(backup, null, 2);
      const file = new File([json], backupFilename(), { type: 'application/json' });

      // share-шит — только на iOS (там это путь в «Файлы»); на десктопе
      // системный share-диалог блокирует страницу, качаем напрямую
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      if (isIOS && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
        } catch (err) {
          // AbortError — пользователь закрыл шит шаринга, это не ошибка
          if (!(err instanceof DOMException && err.name === 'AbortError')) {
            toast(t('Не удалось поделиться файлом резервной копии. Он сохранён — найдите его в «Файлах»'));
          }
          return;
        }
      } else {
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }

      toast(t('Резервная копия сохранена'));
    } finally {
      exportingRef.current = false;
    }
  }

  // Подтверждение + применение копии (файл или облако) — общая логика.
  async function confirmAndImport(backup: BackupFile): Promise<void> {
    const p = previewBackup(backup);
    const msg = t(
      'Импорт заменит ВСЕ текущие данные.\n\nВ резервной копии:\n• проектов: {projects}\n• задач: {tasks}\n• целей: {goals}\n• привычек: {habits}\n• отметок привычек: {habitLogs}\n• заметок: {notes}\n• материалов обучения: {learningItems}\n• записей прогресса: {learningLogs}\n• расходов: {expenseItems}\n• способов восстановления: {energyItems}\n• отметок энергии: {energyLogs}\n• мест: {placeItems}\n• метрик: {metrics}\n• замеров метрик: {metricLogs}\n• семейных сообщений: {familyMessages}\n• семейных задач: {familyTasks}\n• тренировок: {workouts}\n\nПродолжить?',
      {
        projects: p.counts.projects,
        tasks: p.counts.tasks,
        goals: p.counts.goals,
        habits: p.counts.habits,
        habitLogs: p.counts.habitLogs,
        notes: p.counts.notes,
        learningItems: p.counts.learningItems,
        learningLogs: p.counts.learningLogs,
        expenseItems: p.counts.expenseItems,
        energyItems: p.counts.energyItems,
        energyLogs: p.counts.energyLogs ?? 0,
        placeItems: p.counts.placeItems,
        metrics: p.counts.metrics,
        metricLogs: p.counts.metricLogs,
        familyMessages: p.counts.familyMessages ?? 0,
        familyTasks: p.counts.familyTasks ?? 0,
        workouts: p.counts.workouts ?? 0,
      },
    );
    if (!(await confirmAction({ title: msg, confirmLabel: t('Восстановить') }))) return;
    await importBackup(backup);
    toast(t('Данные восстановлены'));
  }

  async function handleImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // позволяет выбрать тот же файл повторно
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      // Сырое сообщение JSON.parse человеку ни о чём — свои слова.
      toast(t('Это не файл резервной копии LifeHearth: внутри не данные, а что-то другое.'));
      return;
    }
    try {
      await confirmAndImport(validateBackup(parsed));
    } catch (err) {
      toast(err instanceof Error ? err.message : t('Не удалось прочитать файл резервной копии'));
    }
  }

  async function handleCloudBackupNow(force = false) {
    if (cloudRef.current) return;
    cloudRef.current = true;
    try {
      const n = await pushAccountSnapshot(force);
      if (!n) {
        toast(t('Сначала включите синхронизацию — облачная копия хранится под вашим ключом.'));
        return;
      }
      await updateSettings({ lastCloudBackupAt: now(), cloudBackupBlocked: null });
      setCloudDate({ state: 'have', updatedAt: new Date().toISOString() });
      toast(t('Копия сохранена в облако'));
    } catch (e) {
      // Копия в облаке полнее, чем данные здесь. Хранение latest-only: запись
      // сотрёт её без следа, а история цикла и старая переписка не приедут
      // обратно ниоткуда — дельта-синк их не возит. Поэтому не «не удалось»,
      // а прямой вопрос с числами: сколько записей исчезнет.
      if (e instanceof BackupWouldLoseDataError) {
        const lines = e.losing.map((l) =>
          t('{table}: {had} → {now}', { table: t(TABLE_RU[l.table] ?? l.table), had: l.had, now: l.now }),
        );
        const when = e.remoteDate
          ? t(' от {date}', { date: formatRu(e.remoteDate.slice(0, 10), 'd MMMM yyyy') })
          : '';
        const ok = (await confirmAction({ title: t(
            'В облаке лежит копия{when}, и в ней БОЛЬШЕ данных, чем на этом устройстве:\n\n{lines}\n\nЗаменить её копией с этого устройства? Разницу вернуть будет неоткуда.',
            { when, lines: lines.join('\n') },
          ), confirmLabel: t('Заменить') }));
        if (ok) await handleCloudBackupNow(true);
        return;
      }
      toast(t('Не удалось сохранить копию в облако. Проверьте связь и попробуйте ещё раз.'));
    } finally {
      cloudRef.current = false;
    }
  }

  async function handleCloudRestore() {
    if (cloudRef.current) return;
    cloudRef.current = true;
    try {
      const backup = await pullAccountSnapshot();
      if (!backup) {
        toast(t('В облаке пока нет резервной копии.'));
        return;
      }
      await confirmAndImport(backup);
    } catch {
      toast(t('Не удалось получить копию из облака. Проверьте связь и попробуйте ещё раз.'));
    } finally {
      cloudRef.current = false;
    }
  }


  const lastFile = settings.lastBackupAt;
  const freshDays = (settings.autoBackupEvery ?? 'daily') === 'weekly' ? 8 : 2;
  const cloudFresh =
    cloudDate?.state === 'have' && Date.now() - new Date(cloudDate.updatedAt).getTime() < freshDays * 86_400_000;

  return (
    <Screen title={t('Резервные копии')} backTo="/more/settings">
      <div className="space-y-6">
        <StorageStatus />

        <section>
          <h2 className="lh-section mb-2.5 px-1">{t('Копия в облаке')}</h2>
          <div className="card">
            <div className="flex gap-3.5 p-4">
              <Tile className="text-lh-accent">
                <GCloud size={ICON.base} />
              </Tile>
              <div className="min-w-0 flex-1">
                {syncOn ? (
                  <>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-base">{t('Последняя копия')}</span>
                      {cloudDate?.state === 'have' && (
                        <span
                          className={`flex items-center gap-1 text-sm ${cloudFresh ? 'text-success' : 'text-warning'}`}
                        >
                          {cloudFresh && <GCheck size={ICON.inline} />}
                          {cloudFresh ? t('актуальна') : t('устарела')}
                        </span>
                      )}
                    </div>
                    {/* Дата — С СЕРВЕРА, а не из settings. Локальная отметка между
                        устройствами не синхронизируется, и на втором телефоне тут
                        всегда горело «ещё не создана» — ровно тот текст, который
                        толкает нажать «Сохранить сейчас» и затереть единственную
                        полную копию снапшотом пустого устройства. */}
                    <p className="mt-0.5 text-xl font-light tabular-nums">
                      {cloudDate === undefined ? (
                        <span className="text-lh-text-secondary">{t('проверяем…')}</span>
                      ) : cloudDate.state === 'have' ? (
                        formatRu(cloudDate.updatedAt.slice(0, 10), 'd MMMM yyyy')
                      ) : cloudDate.state === 'unknown' ? (
                        <span className="text-lh-text-secondary">{t('не удалось проверить')}</span>
                      ) : (
                        <span className="text-warning">{t('ещё не создана')}</span>
                      )}
                    </p>
                    <p className="mt-1.5 text-sm leading-snug text-lh-text-secondary">
                      {t('Зашифрована вашим ключом: на сервере только шифротекст. Переживает потерю или замену телефона.')}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-base">{paused ? t('На паузе') : t('Недоступна')}</p>
                    <p className="mt-0.5 text-sm leading-snug text-lh-text-secondary">
                      {paused
                        ? t('На паузе, пока нет согласия на внешнее: Настройки → Что уходит с телефона')
                        : t('Доступна при включённой синхронизации — ею идёт авторизация.')}
                    </p>
                  </>
                )}
              </div>
            </div>
            {/* Восстановление НЕ зависит от тумблера автозаписи: на новом
                телефоне тумблер выключен по умолчанию, и человек, приехавший
                возвращать данные, видел один выключатель и решал, что копии
                нет. Тумблер — про расписание, восстановление — про беду. */}
            {syncOn && (
              <div className="grid grid-cols-2 gap-2.5 px-4 pb-4">
                <button
                  type="button"
                  onClick={() => void handleCloudBackupNow()}
                  className="h-12 rounded-lh-btn bg-lh-accent text-base font-semibold text-lh-bg active:opacity-80"
                >
                  {t('Сохранить сейчас')}
                </button>
                <button
                  type="button"
                  aria-label={t('Восстановить из облака')}
                  onClick={() => void handleCloudRestore()}
                  className="h-12 rounded-lh-btn bg-lh-surface-2 text-base active:opacity-80"
                >
                  {t('Восстановить')}
                </button>
              </div>
            )}
            <div className="border-t border-lh-border">
              <Row label={t('Автоматическая копия')}>
                {syncOn ? (
                  <Switch
                    checked={settings.autoBackup === 'cloud'}
                    onChange={(on) => void updateSettings({ autoBackup: on ? 'cloud' : 'off' })}
                    label={t('Автоматическая копия')}
                  />
                ) : paused ? (
                  <span className="shrink-0 text-sm font-medium text-warning">{t('На паузе')}</span>
                ) : (
                  <span className="shrink-0 text-sm text-lh-text-secondary">{t('Недоступна')}</span>
                )}
              </Row>
              {syncOn && settings.autoBackup === 'cloud' && (
                <div className="px-4 pb-3">
                  <p className="mb-2 text-sm text-lh-text-secondary">{t('Как часто')}</p>
                  <SegmentedControl<'daily' | 'weekly'>
                    options={[
                      { value: 'daily', label: t('Каждый день') },
                      { value: 'weekly', label: t('Каждую неделю') },
                    ]}
                    value={settings.autoBackupEvery ?? 'daily'}
                    onChange={(v) => void updateSettings({ autoBackupEvery: v })}
                  />
                </div>
              )}
            </div>
          </div>
          {settings.cloudBackupBlocked && (
            <p className="mt-2 px-1 text-sm leading-snug text-warning">
              {t(
                'Автокопия приостановлена: в облаке лежит копия полнее, чем данные на этом устройстве. Нажмите «Сохранить сейчас», чтобы решить, что с этим делать.',
              )}
            </p>
          )}
        </section>

        {/* Прямо о том, что в файле. Копия в облако шифруется ключом на
            устройстве, а файл — обычный JSON: он читается любым, кто его
            откроет. Человек имеет право знать это ДО того, как отправит файл
            себе в мессенджер. */}
        <section>
          <h2 className="lh-section mb-2.5 px-1">{t('Копия файлом')}</h2>
          <div className="card">
            <div className="flex gap-3.5 p-4">
              <Tile className="text-lh-text-secondary">
                <FileArchive size={ICON.base} />
              </Tile>
              <div className="min-w-0 flex-1">
                <p className="text-base">{t('Файл на телефоне или в iCloud')}</p>
                <p className="mt-1 flex gap-1.5 text-sm leading-snug text-warning">
                  <GAlert size={ICON.inline} className="mt-[3px] shrink-0" />
                  <span>
                    {t(
                      'В файл входит всё: задачи, заметки, финансы, семейный чат и «Женские дни», если вы им пользуетесь. Файл НЕ зашифрован — храните там, куда нет доступа у посторонних.',
                    )}
                  </span>
                </p>
              </div>
            </div>
            <div className="divide-y divide-lh-border border-t border-lh-border">
              <button
                type="button"
                onClick={() => void handleExport()}
                className="flex h-14 w-full items-center gap-3 px-4 text-left text-base text-lh-accent active:bg-lh-surface-2"
              >
                <Download size={ICON.header} />
                <span className="min-w-0 flex-1 truncate">{t('Сохранить в файл')}</span>
                <span className={`shrink-0 text-sm ${lastFile ? 'text-lh-text-secondary' : 'font-semibold text-warning'}`}>
                  {lastFile ? formatRu(lastFile.slice(0, 10), 'd MMMM yyyy') : t('никогда')}
                </span>
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex h-14 w-full items-center gap-3 px-4 text-left text-base active:bg-lh-surface-2"
              >
                <FolderOpen size={ICON.header} className="text-lh-text-secondary" />
                <span className="min-w-0 flex-1 truncate">{t('Восстановить из файла')}</span>
                <GChevronRight size={ICON.action} className="text-lh-text-secondary" />
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => void handleImport(e)}
            />
          </div>
        </section>

        <section>
          <h2 className="lh-section mb-2.5 px-1">{t('Хранилище')}</h2>
          <div className="card">
            <Row
              label={t('Защищённое хранилище')}
              value={
                // «Нет» — омоним ключа приоритета задач (None); здесь ответ
                // «да/нет» — явная ветка языка.
                persisted === null
                  ? t('Неизвестно')
                  : persisted
                    ? t('Да')
                    : getLang() === 'en'
                      ? 'No'
                      : 'Нет'
              }
            />
            <Row
              // «Занято» — омоним ключа причины звонка (Busy); здесь объём
              // хранилища — явная ветка языка.
              label={getLang() === 'en' ? 'Used' : 'Занято'}
              value={
                usageMb === null
                  ? t('неизвестно')
                  : t('{n}\u00A0МБ', {
                      n: getLang() === 'en' ? usageMb.toFixed(1) : usageMb.toFixed(1).replace('.', ','),
                    })
              }
            />
          </div>
          <p className="mt-2.5 px-1 text-sm leading-snug text-lh-text-secondary">
            {t('Перед восстановлением покажем, что в копии и что изменится, — ничего не пропадёт молча.')}
          </p>
        </section>
      </div>
    </Screen>
  );
}
