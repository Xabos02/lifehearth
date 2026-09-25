import { useRef, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { FileText } from 'lucide-react';
import {
  GCheck as Check,
  GChevronRight as ChevronRight,
} from '../../components/ui/glyphs';
import { Screen } from '../../components/layout/Screen';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Input';
import { hashPin } from '../../lib/crypto';
import { isUnlocked, lockCycleSection, subscribeLock } from './lockState';
import { CycleLock } from './CycleLock';
import { db } from '../../db/db';
import type { CycleSettings } from '../../db/cycleTypes';
import { DEFAULT_CYCLE_SETTINGS, putDay, updateCycleSettings } from '../../lib/cycle/cycleRepo';
import { parseCycleCsv, type ImportReport } from '../../lib/cycle/importCsv';
import { formatRu } from '../../lib/dates';
import { AUTO_TASK_TEMPLATES, MAX_ACTIVE_AUTO_TASKS } from '../../lib/cycle/autoTasks';
import { ICON, STROKE_HEAVY } from '../../components/ui/icons';
import { t } from '../../lib/i18n';

/** Переключатель строкой. Своя реализация вместо нативного checkbox: нужен
 *  крупный тач-таргет на всю строку и подпись под заголовком, а нативный
 *  input этого не даёт без обёрток, которые всё равно пришлось бы писать. */
function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 py-3.5 text-left disabled:opacity-40"
    >
      {/* Пол ширины подписи: без него длинный заголовок ужимает саму галочку. */}
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        {hint && <span className="mt-0.5 block text-sm leading-snug text-muted">{hint}</span>}
      </span>
      <span
        aria-hidden
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[6px] border transition-colors ${
          checked ? 'border-accent bg-accent-fill text-white' : 'border-border bg-surface-2'
        }`}
      >
        {checked && <Check size={ICON.inline} strokeWidth={STROKE_HEAVY} />}
      </span>
    </button>
  );
}

/** Код доступа к разделу. Отдельным блоком, потому что это единственное место
 *  в приложении, где что-то закрывается кодом, и правила тут свои. */
function PinSection({ settings }: { settings: CycleSettings }) {
  const [pin, setPin] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const has = settings.lock === 'pin' && settings.pin !== undefined;

  async function save() {
    if (pin.length < 4 || pin !== repeat || busy) return;
    setBusy(true);
    try {
      await updateCycleSettings({ lock: 'pin', pin: await hashPin(pin) });
      setPin('');
      setRepeat('');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(t('Убрать код? Раздел будет открываться без него.'))) return;
    await updateCycleSettings({ lock: 'none', pin: undefined });
    lockCycleSection();
  }

  return (
    <section>
      <h2 className="mb-1.5 px-1 text-sm font-semibold text-muted">{t('Код доступа')}</h2>
      <div className="card space-y-3 p-4">
        {has ? (
          <>
            <p className="text-sm text-muted">
              {t('Раздел закрыт кодом. Он спрашивается при каждом открытии приложения.')}
            </p>
            <Button variant="secondary" className="w-full" onClick={() => void remove()}>
              {t('Убрать код')}
            </Button>
          </>
        ) : (
          <>
            {/* Столбик, а не два поля в ряд: на 320px пара полей по 4-8 цифр
                ужимается до нечитаемого, а поля кода набирают вслепую. */}
            <Field label={t('Код (4–8 цифр)')}>
              <Input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
              />
            </Field>
            <Field label={t('Ещё раз')}>
              <Input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value.replace(/\D/g, '').slice(0, 8))}
              />
            </Field>
            {repeat.length > 0 && pin !== repeat && (
              <p className="text-sm text-danger">{t('Коды не совпадают')}</p>
            )}
            <Button
              className="w-full"
              disabled={pin.length < 4 || pin !== repeat || busy}
              onClick={() => void save()}
            >
              {t('Установить код')}
            </Button>
          </>
        )}
        {/* Прямо о границах защиты. Обещать больше, чем код даёт, — хуже, чем
            не иметь кода: человек станет полагаться на то, чего нет. */}
        <p className="text-xs leading-snug text-muted">
          {t(
            'Код закрывает раздел от посторонних глаз, но не шифрует записи: тот, кто разбирается в устройстве телефона, сможет их прочитать в обход. Шифровать данные кодом мы не стали сознательно — забытый код означал бы потерю всей истории, а восстановить её неоткуда. Сам код нигде не хранится, сверяется только его отпечаток.',
          )}
        </p>
      </div>
    </section>
  );
}

/** Перенос истории из другого приложения.
 *
 *  Разбор терпим к формату и НЕ подогнан под конкретный трекер: точных схем
 *  выгрузки у меня нет, а «парсер Flo», написанный по догадкам об именах
 *  колонок, не заработал бы ни с одним настоящим файлом. Колонки определяются
 *  по смыслу, а результат показывается до записи — человек видит, что именно
 *  распозналось, и решает сам. */
function ImportSection() {
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  async function pick(file: File) {
    setDone(0);
    setReport(parseCycleCsv(await file.text()));
  }

  async function apply() {
    if (!report || busy) return;
    setBusy(true);
    try {
      for (const d of report.days) {
        // Через putDay, а не прямой записью: он же держит в синхроне
        // денормализованные ключи и пересчитывает циклы.
        await putDay(d.date, { bleeding: d.bleeding });
      }
      setDone(report.days.length);
      setReport(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="mb-1.5 px-1 text-sm font-semibold text-muted">
        {t('Перенос из другого приложения')}
      </h2>
      <div className="card p-4">
        <p className="mb-3 text-sm leading-snug text-muted">
          {t(
            'Выгрузите историю из прежнего трекера в CSV и выберите файл здесь. Нужны колонки с датой и отметкой выделений — как они называются, приложение разберётся само.',
          )}
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pick(f);
            e.target.value = ''; // тот же файл можно выбрать повторно
          }}
        />
        <Button variant="secondary" className="w-full" onClick={() => fileRef.current?.click()}>
          {t('Выбрать файл')}
        </Button>

        {done > 0 && (
          <p className="mt-3 text-sm text-success">
            {t('Перенесено дней: {n}. Прогноз пересчитан.', { n: done })}
          </p>
        )}

        {report && (
          <div className="mt-4 space-y-2 text-sm leading-snug">
            {report.days.length === 0 ? (
              <p className="text-danger">
                {report.dateColumn
                  ? t(
                      'Даты нашлись, а отметок выделений — нет. Проверьте, что в файле есть колонка с ними.',
                    )
                  : t('Не нашлась колонка с датой. Проверьте, что выгрузка сохранена в CSV.')}
              </p>
            ) : (
              <>
                <p>
                  {t('Распознано дней:')} <span className="font-semibold">{report.days.length}</span>
                  {report.from && report.to && (
                    <> — {t('с {from} по {to}', { from: formatRu(report.from), to: formatRu(report.to) })}</>
                  )}
                </p>
                {/* Показываем, ЧТО именно взято за дату и за выделения: человек
                    должен убедиться, что разобрано то, что он думает, а не
                    соседняя колонка. */}
                <p className="text-muted">
                  {t('Колонка с датой: «{col}»', { col: report.dateColumn ?? '' })}
                  {report.flowColumn
                    ? t(', выделения: «{col}»', { col: report.flowColumn })
                    : t(', выделения — по содержимому строк')}
                </p>
                {(report.skippedNoDate > 0 || report.skippedNoFlow > 0) && (
                  <p className="text-warning">
                    {t('Пропущено строк: {n}', { n: report.skippedNoDate + report.skippedNoFlow })}
                    {report.skippedNoDate > 0 && t(' (без даты: {n})', { n: report.skippedNoDate })}
                    {report.skippedNoFlow > 0 && t(' (без отметки: {n})', { n: report.skippedNoFlow })}
                  </p>
                )}
                <p className="text-muted">
                  {t(
                    'Записи за те же дни будут заменены. Отменить перенос нельзя — если история уже есть, сделайте резервную копию заранее.',
                  )}
                </p>
                <Button className="w-full" disabled={busy} onClick={() => void apply()}>
                  {busy ? t('Переносим…') : t('Перенести {n}', { n: report.days.length })}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function CycleSettingsPage() {
  const row = useLiveQuery(() => db.cycleSettings.get('app'), []);
  const s: CycleSettings = row ?? { ...DEFAULT_CYCLE_SETTINGS, updatedAt: '' };
  // Тот же замок, что у остальных экранов раздела: настройки открывались по
  // прямому адресу в обход кода, и «Убрать код» снимал замок без ввода кода.
  const open = useSyncExternalStore(subscribeLock, isUnlocked, () => false);
  const locked = s.lock === 'pin' && s.pin !== undefined && !open;

  const setIntegration = (key: keyof CycleSettings['integrations'], value: boolean) =>
    void updateCycleSettings({ integrations: { ...s.integrations, [key]: value } });

  if (locked) {
    return (
      <Screen title={t('Настройки раздела')} backTo="/more/cycle">
        <CycleLock settings={s} onUnlock={() => undefined} />
      </Screen>
    );
  }

  return (
    <Screen title={t('Настройки раздела')} backTo="/more/cycle">
      <div className="space-y-5">
        <section>
          <h2 className="mb-1.5 px-1 text-sm font-semibold text-muted">{t('Прогноз')}</h2>
          <div className="card divide-y divide-hairline px-4">
            <ToggleRow
              label={t('Показывать прогноз')}
              hint={t('Когда выключено, раздел ведёт только календарь — без оценок и диапазонов.')}
              checked={s.predictionsEnabled}
              onChange={(v) => void updateCycleSettings({ predictionsEnabled: v })}
            />
            <ToggleRow
              label={t('Фертильные дни')}
              hint={t(
                'Оценка окна зачатия. По календарю она приблизительная — интервал около двух недель, поэтому для предохранения не годится.',
              )}
              checked={s.fertilityDisplay !== 'off'}
              onChange={(v) =>
                void updateCycleSettings({ fertilityDisplay: v ? 'probability_map' : 'off' })
              }
            />
          </div>
        </section>

        <section>
          <h2 className="mb-1.5 px-1 text-sm font-semibold text-muted">{t('Связь с приложением')}</h2>
          <div className="card divide-y divide-hairline px-4">
            <ToggleRow
              label={t('Задачи по циклу')}
              hint={t(
                'Приложение само поставит «{title}» перед ожидаемой менструацией и напомнит о плановом визите к врачу. Не больше {n} задач одновременно.',
                { title: t(AUTO_TASK_TEMPLATES.supplies.title), n: MAX_ACTIVE_AUTO_TASKS },
              )}
              checked={s.integrations.autoTasks}
              onChange={(v) => setIntegration('autoTasks', v)}
            />
            <ToggleRow
              label={t('Строка на экране «Сегодня»')}
              hint={t('День цикла и, если включён прогноз, ожидаемые даты.')}
              checked={s.integrations.todayCard}
              onChange={(v) => setIntegration('todayCard', v)}
            />
            <ToggleRow
              label={t('Отметки в календаре')}
              hint={t('Дни менструации и диапазон прогноза в общем календаре приложения.')}
              checked={s.integrations.calendarMarks}
              onChange={(v) => setIntegration('calendarMarks', v)}
            />
            {/* Тумблер «Сравнение с энергией» здесь стоял с обещанием, которое
                нечем выполнить: дневных отметок энергии в приложении нет —
                раздел «Энергия» хранит способы восстановления, а не уровень по
                дням. Флаг energyCorrelation остаётся в схеме на случай, если
                дневник энергии появится; из интерфейса обещание убрано. */}
            <ToggleRow
              label={t('Привычки по дням цикла')}
              hint={t(
                'Доля выполненных привычек в дни менструации, перед ней и в остальные дни. Только ваши числа, без выводов и советов.',
              )}
              checked={s.integrations.habitsCorrelation}
              onChange={(v) => setIntegration('habitsCorrelation', v)}
            />
          </div>
          {/* Прямая оговорка про то, чего раздел делать не будет. Стоит рядом с
              переключателями, а не в справке: именно здесь человек решает,
              сколько приложению позволено. */}
          <p className="mt-2 px-1 text-xs leading-snug text-muted">
            {t(
              'Приложение не будет подстраивать за вас план дня, тренировки или задачи под фазу цикла. Влияние фазы на работоспособность в исследованиях оказалось незначительным, а советы вроде «сегодня не берись за сложное» вредят больше, чем помогают.',
            )}
          </p>
        </section>

        <section>
          <h2 className="mb-1.5 px-1 text-sm font-semibold text-muted">{t('Формулировки')}</h2>
          <div className="card divide-y divide-hairline px-4">
            <ToggleRow
              label={t('Нейтральные названия')}
              hint={t(
                'Задачи и уведомления называются обтекаемо: «{title}» вместо «{direct}». Список задач видно с чужого плеча чаще, чем сам раздел.',
                {
                  title: t(AUTO_TASK_TEMPLATES.supplies.title),
                  direct: t(AUTO_TASK_TEMPLATES.supplies.directTitle),
                },
              )}
              checked={s.neutralNotificationText}
              onChange={(v) => void updateCycleSettings({ neutralNotificationText: v })}
            />
          </div>
        </section>

        <PinSection settings={s} />

        <section>
          <h2 className="mb-1.5 px-1 text-sm font-semibold text-muted">{t('Врач')}</h2>
          <div className="card">
            <Link to="/more/cycle/report" className="flex items-center gap-3 p-4">
              <FileText size={ICON.header} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{t('Отчёт для врача')}</span>
                <span className="mt-0.5 block text-sm leading-snug text-muted">
                  {t('Сводка по циклам за период — для показа или печати на приёме.')}
                </span>
              </span>
              <ChevronRight size={ICON.header} className="shrink-0 text-muted" />
            </Link>
          </div>
        </section>

        <section>
          <h2 className="mb-1.5 px-1 text-sm font-semibold text-muted">{t('Данные')}</h2>
          <div className="card divide-y divide-hairline px-4">
            <ToggleRow
              label={t('Синхронизация между устройствами')}
              hint={t(
                'Пока недоступна: записи раздела не передаются между устройствами. В облачную копию они попадают зашифрованными, если включено «Включать в резервную копию».',
              )}
              checked={s.syncEnabled}
              onChange={() => undefined}
              disabled
            />
            <ToggleRow
              label={t('Включать в резервную копию')}
              hint={t(
                'Раздел не синхронизируется, поэтому копия — единственное, что спасёт историю при потере телефона. Если выключить, записи в копию не попадут и восстановить их будет неоткуда.',
              )}
              checked={s.includeInGeneralBackup}
              onChange={(v) => void updateCycleSettings({ includeInGeneralBackup: v })}
            />
          </div>
        </section>

        <ImportSection />
      </div>
    </Screen>
  );
}
