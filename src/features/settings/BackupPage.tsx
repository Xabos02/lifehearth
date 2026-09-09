import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getLang, t } from '../../lib/i18n';
import { Screen } from '../../components/layout/Screen';
import { Select } from '../../components/ui/Input';
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
import { ButtonRow, Row, Section } from './SettingsSection';
import { Switch } from '../../components/ui/Switch';

/** Состояние локального хранилища. Показываем ровно тогда, когда есть что
 *  сказать: браузер отказал в постоянном хранении — значит данные могут быть
 *  стёрты системой, и копия становится не рекомендацией, а необходимостью. */
function StorageStatus() {
  const [state, setState] = useState<StorageState | null>(null);
  useEffect(() => {
    void ensurePersistentStorage().then(setState);
  }, []);

  if (!state || state.persisted === undefined) return null;
  const used = state.usage !== undefined ? formatBytes(state.usage) : null;

  return state.persisted ? (
    <p className="text-sm text-muted">
      {t('Данные защищены от автоочистки браузером{suffix}.', {
        suffix: used ? t(', занято {used}', { used }) : '',
      })}
    </p>
  ) : (
    <p className="text-sm leading-snug">
      <span className="font-semibold text-warning">
        {t('Браузер не гарантирует сохранность данных.')}
      </span>{' '}
      <span className="text-muted">
        {t(
          'Если открывать приложение как обычную вкладку, Safari стирает данные сайта после недели без визитов. Установите приложение на экран «Домой» и держите копию{suffix}.',
          { suffix: used ? t(' (сейчас занято {used})', { used }) : '' },
        )}
      </span>
    </p>
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
  const syncOn = Boolean(syncCfg?.enabled);
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

      await updateSettings({ lastBackupAt: now() });
      toast(t('Резервная копия сохранена'));
    } finally {
      exportingRef.current = false;
    }
  }

  // Подтверждение + применение копии (файл или облако) — общая логика.
  async function confirmAndImport(backup: BackupFile): Promise<void> {
    const p = previewBackup(backup);
    const msg = t(
      'Импорт заменит ВСЕ текущие данные.\n\nВ резервной копии:\n• проектов: {projects}\n• задач: {tasks}\n• целей: {goals}\n• привычек: {habits}\n• отметок привычек: {habitLogs}\n• заметок: {notes}\n• материалов обучения: {learningItems}\n• записей прогресса: {learningLogs}\n• расходов: {expenseItems}\n• способов восстановления: {energyItems}\n• отметок энергии: {energyLogs}\n• мест: {placeItems}\n• метрик: {metrics}\n• замеров метрик: {metricLogs}\n• семейных сообщений: {familyMessages}\n• семейных задач: {familyTasks}\n\nПродолжить?',
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
      },
    );
    if (!window.confirm(msg)) return;
    await importBackup(backup);
    toast(t('Данные восстановлены'));
  }

  async function handleImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // позволяет выбрать тот же файл повторно
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
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
        const ok = window.confirm(
          t(
            'В облаке лежит копия{when}, и в ней БОЛЬШЕ данных, чем на этом устройстве:\n\n{lines}\n\nЗаменить её копией с этого устройства? Разницу вернуть будет неоткуда.',
            { when, lines: lines.join('\n') },
          ),
        );
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


  return (
    <Screen title={t('Резервные копии')} backTo="/more/settings">
      <div className="space-y-6">
        <Section
          title={t('Копия в облаке')}
          footnote={
            syncOn
              ? t('Зашифрована вашим ключом: на сервере только шифротекст. Переживает потерю или замену телефона.')
              : t('Доступна при включённой синхронизации — ею идёт авторизация.')
          }
        >
          <div className="card">
            <Row label={t('Автоматическая копия')}>
              {syncOn ? (
                <Switch
                  checked={settings.autoBackup === 'cloud'}
                  onChange={(on) => void updateSettings({ autoBackup: on ? 'cloud' : 'off' })}
                  label={t('Автоматическая копия')}
                />
              ) : (
                <span className="shrink-0 text-sm text-muted">{t('Недоступна')}</span>
              )}
            </Row>
            {/* Восстановление вынесено ИЗ-ПОД тумблера автозаписи: раньше и
                «Сохранить сейчас», и «Восстановить из облака» показывались
                только при включённой автокопии. На новом телефоне тумблер
                выключен по умолчанию, и человек, приехавший сюда возвращать
                данные, видел один выключатель и делал вывод, что копии нет.
                Тумблер — про расписание, восстановление — про беду. */}
            {syncOn && (
              <ButtonRow
                label={t('Восстановить из облака')}
                action={t('Начать')}
                onClick={() => void handleCloudRestore()}
              />
            )}
            {syncOn && settings.autoBackup === 'cloud' && (
              <>
                <Row label={t('Как часто')}>
                  {/* compact-Select: под системную стрелку уходило ~40px внутри
                      поля, и «Каждую неделю» не помещалось — читалось
                      «Каждую не…». */}
                  <Select
                    compact
                    className="font-medium"
                    aria-label={t('Как часто')}
                    value={settings.autoBackupEvery ?? 'daily'}
                    onChange={(e) =>
                      void updateSettings({ autoBackupEvery: e.target.value as 'daily' | 'weekly' })
                    }
                  >
                    <option value="daily">{t('Каждый день')}</option>
                    <option value="weekly">{t('Каждую неделю')}</option>
                  </Select>
                </Row>
                {/* Дата — С СЕРВЕРА, а не из settings. Локальная отметка между
                    устройствами не синхронизируется, и на втором телефоне тут
                    всегда горело «ещё не создана» — ровно тот текст, который
                    толкает нажать «Сохранить сейчас» и затереть единственную
                    полную копию снапшотом пустого устройства. Пока ответ не
                    пришёл, не пишем ничего. */}
                <Row
                  label={t('Последняя копия')}
                  value={
                    cloudDate === undefined ? (
                      <span className="opacity-60">{t('проверяем…')}</span>
                    ) : cloudDate.state === 'have' ? (
                      formatRu(cloudDate.updatedAt.slice(0, 10), 'd MMMM yyyy')
                    ) : cloudDate.state === 'unknown' ? (
                      <span className="text-muted">{t('не удалось проверить')}</span>
                    ) : (
                      <span className="font-semibold text-warning">{t('ещё не создана')}</span>
                    )
                  }
                />
                <ButtonRow
                  label={t('Сохранить сейчас')}
                  action={t('Создать')}
                  onClick={() => void handleCloudBackupNow()}
                />
              </>
            )}
          </div>
          {settings.cloudBackupBlocked && (
            <p className="mt-2 px-1 text-xs leading-snug text-warning">
              {t(
                'Автокопия приостановлена: в облаке лежит копия полнее, чем данные на этом устройстве. Нажмите «Сохранить сейчас», чтобы решить, что с этим делать.',
              )}
            </p>
          )}
        </Section>

        {/* Прямо о том, что в файле. Копия в облако шифруется ключом на
            устройстве, а файл — обычный JSON: он читается любым, кто его
            откроет. Человек имеет право знать это ДО того, как отправит файл
            себе в мессенджер. */}
        <Section
          title={t('Копия файлом')}
          footnote={t(
            'В файл входит всё: задачи, заметки, финансы, семейный чат и «Женские дни», если вы им пользуетесь. Файл НЕ зашифрован — храните там, куда нет доступа у посторонних.',
          )}
        >
          <div className="card">
            <Row
              label={t('Последняя копия')}
              value={
                settings.lastBackupAt ? (
                  formatRu(settings.lastBackupAt.slice(0, 10), 'd MMMM yyyy')
                ) : (
                  <span className="font-semibold text-warning">{t('никогда')}</span>
                )
              }
            />
            <ButtonRow
              label={t('Сохранить в файл')}
              action={t('Создать')}
              onClick={() => void handleExport()}
            />
            <ButtonRow
              label={t('Восстановить')}
              action={t('Выбрать файл')}
              onClick={() => fileRef.current?.click()}
            />
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => void handleImport(e)}
            />
          </div>
        </Section>

        <Section title={t('Хранилище')}>
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
              label={t('Занято')}
              value={
                usageMb === null
                  ? t('неизвестно')
                  : t('{n}\u00A0МБ', {
                      n: getLang() === 'en' ? usageMb.toFixed(1) : usageMb.toFixed(1).replace('.', ','),
                    })
              }
            />
          </div>
          <StorageStatus />
        </Section>
      </div>
    </Screen>
  );
}
