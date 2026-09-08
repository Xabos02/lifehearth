import { useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  PhoneCall,
  SlidersHorizontal,
  Lightbulb,
} from 'lucide-react';
import {
  GChevronRight as ChevronRight,
  GTrash as Trash2,
  GBot as Bot,
  GLearning as GraduationCap,
  GBellRing as BellRing,
  GTasks as ListChecks,
} from '../../components/ui/glyphs';
import { ACCENTS } from '../../lib/accents';
import { getLang, resolveLang, t } from '../../lib/i18n';
import { APP_VERSION } from '../../lib/changelog';
import { MESSAGE_SOUNDS, playMessageSound, type MessageSound } from '../../lib/sounds';
import { RINGTONES, previewRingtone, type RingtoneKind } from '../../lib/family/ringtone';
import { Screen } from '../../components/layout/Screen';
import { Select } from '../../components/ui/Input';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { useToast } from '../../components/ui/toastContext';
import { useSettings, updateSettings } from '../../hooks/useSettings';
import { db } from '../../db/db';
import { alive } from '../../db/repo';
import { enablePush, isIOS, isStandalone, pushEnabled, pushSupported, rescheduleAll } from '../../lib/push';
import { formatRu } from '../../lib/dates';
import { HINT_IDS, resetSessionHints } from '../../hooks/useHint';
import { SyncSection } from './sync/SyncSection';
import type { Settings } from '../../db/types';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { Switch } from '../../components/ui/Switch';
import { ButtonRow, LinkRow, Row, Section } from './SettingsSection';

const THEME_OPTIONS: { value: Settings['theme']; label: string }[] = [
  { value: 'dark', label: 'Тёмная' },
  { value: 'light', label: 'Светлая' },
  { value: 'system', label: 'Системная' },
];

/** Возврат скрытых подсказок. Отдельной строкой от сброса обучения, с живым
 *  счётчиком: кнопка без обратной связи выглядит как сломанная — нажал, ничего
 *  видимого не случилось, а подсказка всплывёт когда-то потом на своём экране. */
function HintsResetRow() {
  const settings = useSettings();
  const hidden = settings.seenHints?.length ?? 0;
  const nothingToReset = hidden === 0;

  return (
    <button
      type="button"
      disabled={nothingToReset}
      onClick={() => {
        void updateSettings({ seenHints: [] });
        // И те, что скрыты «только сейчас», — иначе кнопка вернула бы часть
        // подсказок, а человек считает их одним набором.
        resetSessionHints();
      }}
      className="flex w-full items-center gap-2 border-b border-hairline p-4 text-left disabled:opacity-40"
    >
      <Lightbulb size={ICON.header} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{t('Показать подсказки заново')}</span>
        <span className="block text-sm text-muted">
          {nothingToReset
            ? t('Все подсказки на месте')
            : t('Скрыто {hidden} из {total}', { hidden, total: HINT_IDS.length })}
        </span>
      </span>
      <ChevronRight size={ICON.header} className="shrink-0 text-muted" />
    </button>
  );
}

/** Что показать справа у строки «Копии и восстановление»: когда копию делали
 *  в последний раз. Смысл строки в списке — не открывать её без нужды, поэтому
 *  главное («копии нет») видно сразу, жёлтым. */
function BackupStatus() {
  const settings = useSettings();
  const last = settings.lastBackupAt;
  if (!last) return <span className="shrink-0 text-sm font-medium text-warning">{t('нет копии')}</span>;
  return <span className="shrink-0 text-sm text-muted">{formatRu(last.slice(0, 10))}</span>;
}

export function SettingsPage() {
  const settings = useSettings();
  const toast = useToast();
  const [pushOn, setPushOn] = useState(pushEnabled());
  // Защита от повторного запуска async-операций при быстрых повторных кликах.
  const pushingRef = useRef(false);
  async function handleEnablePush() {
    if (!pushSupported()) {
      toast(t('Уведомления не поддерживаются этим браузером.'));
      return;
    }
    if (isIOS() && !isStandalone()) {
      toast(
        t(
          'На iPhone уведомления работают только в установленном приложении. Добавьте LifeHearth на экран «Домой» и откройте оттуда.',
        ),
      );
      return;
    }
    if (pushingRef.current) return;
    pushingRef.current = true;
    try {
      const res = await enablePush();
      if (!res.ok) {
        toast(
          res.reason === 'denied'
            ? t('Разрешение не выдано. Включите его: Настройки iPhone → Уведомления → LifeHearth.')
            : t('Не удалось включить уведомления.'),
        );
        return;
      }
      setPushOn(true);
      const tasks = alive(await db.tasks.toArray()).filter((task) => !task.completedAt);
      await rescheduleAll(tasks);
      toast(t('Уведомления включены'));
    } finally {
      pushingRef.current = false;
    }
  }

  // Светлая ли тема прямо сейчас: образцы акцентов рисуются цветами ТЕКУЩЕЙ
  // темы, иначе превью обещает не те цвета, что человек получит.
  const light =
    settings.theme === 'light' ||
    (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  const selectedAccent = ACCENTS.find((a) => a.id === (settings.accent ?? 'indigo')) ?? ACCENTS[0];

  return (
    <Screen title={t('Настройки')} backTo="/home">
      <div className="space-y-6">
        <Section title={t('Оформление')}>
          <div className="card">
            <div className="p-4">
              <SegmentedControl
                options={THEME_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
                value={settings.theme}
                onChange={(theme) => void updateSettings({ theme })}
              />
            </div>
            {/* ВЫБОР ЦВЕТА — РЯД ОБРАЗЦОВ, А НЕ СПИСОК СТРОК.
                Раньше каждый акцент был строкой с названием, описанием и
                галочкой: 262px на три варианта, и сравнить цвета было нельзя —
                они разнесены по вертикали, глаз держит только соседние. Цвет
                объясняет себя сам, названию место у выбранного.

                Образец показывает акцент и его пару градиентом — те же два
                цвета, которыми потом красится интерфейс. Цвета берутся для
                ТЕКУЩЕЙ темы: превью в чужой теме обещало бы не то, что человек
                получит. Акцент применяется мгновенно, так что сам экран и есть
                предпросмотр. */}
            <div className="flex items-center gap-3.5 border-t border-hairline p-3.5">
              {ACCENTS.map((a) => {
                const selected = (settings.accent ?? 'indigo') === a.id;
                const [c1, c2] = light ? a.light : a.dark;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => void updateSettings({ accent: a.id })}
                    aria-pressed={selected}
                    aria-label={t(a.label)}
                    // Кольцо цветом самого акцента, с зазором цвета карточки —
                    // белая обводка спорила бы с палитрой, а без зазора кольцо
                    // сливается с образцом.
                    // Выбор показывает КОЛЬЦО, а не галочка внутри образца:
                    // белый глиф на светлом акценте дал 2.62:1 при норме 3 для
                    // иконок (поймал прогон контраста), а перекрашивать его в
                    // тёмный пришлось бы по-разному для каждого акцента.
                    // Кольцо ничего не перекрывает и читается на любом цвете:
                    // зазор цвета карточки отделяет его от самого образца.
                    className="size-11 shrink-0 rounded-full transition-transform active:scale-95"
                    style={{
                      background: `linear-gradient(135deg, ${c1}, ${c2})`,
                      boxShadow: selected ? `0 0 0 2.5px var(--app-surface), 0 0 0 5px ${c1}` : undefined,
                    }}
                  />
                );
              })}
              {/* Подпись выбранного — справа: она объясняет ровно один образец,
                  и повторять её у каждого незачем. */}
              <span className="min-w-0 flex-1 text-right">
                <span className="block truncate font-semibold">{t(selectedAccent.label)}</span>
                <span className="block truncate text-xs text-muted">{t(selectedAccent.hint)}</span>
              </span>
            </div>
            {/* Смена языка перерисовывает приложение перезагрузкой: строки
                читаются в момент рендера, reload — честный способ обновить
                каждую (язык меняют раз в жизни, цена приемлема). */}
            <div className="flex flex-wrap items-center gap-2 border-t border-hairline p-4">
              <span className="flex-1">{t('Язык')}</span>
              <Select
                compact
                aria-label={t('Язык')}
                value={settings.language ?? 'system'}
                onChange={(e) => {
                  const v = e.target.value;
                  const language = v === 'system' ? undefined : (v as 'ru' | 'en');
                  void updateSettings({ language }).then(() => {
                    if (resolveLang(language) !== getLang()) window.location.reload();
                  });
                }}
              >
                <option value="system">{t('Как в системе')}</option>
                <option value="ru">{t('Русский')}</option>
                <option value="en">English</option>
              </Select>
            </div>
          </div>
        </Section>

        <Section
          title={t('Уведомления')}
          footnote={t(
            'Напоминания о задачах, сообщения семейного чата и звонки. На iPhone работают только в установленном приложении.',
          )}
        >
          <div className="card">
            <Row icon={BellRing} label={t('Уведомления')}>
              {pushOn ? (
                <span className="shrink-0 text-sm font-medium text-success">{t('Включены')}</span>
              ) : (
                // Кнопка, а не переключатель: включение уходит в системный
                // запрос разрешения, и отменить его приложение не может —
                // переключатель обещал бы обратимость, которой нет.
                <button
                  type="button"
                  onClick={() => void handleEnablePush()}
                  className={`shrink-0 rounded-full bg-accent-fill px-3.5 py-2 text-sm font-semibold text-white active:opacity-80 ${HIT_SLOP_44}`}
                >
                  {t('Включить')}
                </button>
              )}
            </Row>
            {/* Подписи строк ниже намеренно без truncate: обрезать их нельзя —
                из «Класс…» вместо «Классический» непонятно, какой звук выбран.
                Но и min-w-0 у подписи стоять не должно: с ним она сжималась ниже
                своего min-content, и слово «сообщений» (100px) вылезало из
                отведённых 67px прямо под непрозрачный чип селекта — 24.8px
                глифов оказывались под ним, а тап в конце строки попадал в select.
                Без min-w-0 подпись держит ширину слова, а перенести на вторую
                строку не помещающийся чип позволяет flex-wrap: на 320px иконка
                20 + подпись 100 + чип 115 + зазоры 17 = 252px против 250px
                доступных — чип уезжает на вторую строку целиком. На широких
                экранах ничего не меняется: всё влезает в одну строку, и flex-1
                подписи по-прежнему прижимает селект к правому краю. */}
            <Row icon={BellRing} label={t('Сообщения')}>
              {/* Выбор сразу проигрывает звук — слышно, что выбираешь. */}
              {/* compact-Select вместо голого <select>: он снимает системную
                  стрелку, съедавшую ~40px внутри поля, и берёт ширину по самому
                  длинному варианту. Прежние min-w-0 + max-w-[45%] были защитой от
                  выдавливания строки за пределы .card (overflow:hidden) — с чипом
                  по контенту (115px из 250px) выдавливать уже нечем. */}
              <Select
                compact
                value={settings.messageSound ?? 'tritone'}
                onChange={(e) => {
                  const v = e.target.value as MessageSound;
                  void updateSettings({ messageSound: v });
                  void playMessageSound(v);
                }}
              >
                {MESSAGE_SOUNDS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {t(s.label)}
                  </option>
                ))}
              </Select>
            </Row>
            <Row icon={PhoneCall} label={t('Звонки')}>
              {/* Выбор сразу проигрывает короткий фрагмент рингтона. */}
              <Select
                compact
                value={settings.callSound ?? 'classic'}
                onChange={(e) => {
                  const v = e.target.value as RingtoneKind;
                  void updateSettings({ callSound: v });
                  previewRingtone(v);
                }}
              >
                {RINGTONES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {t(r.label)}
                  </option>
                ))}
              </Select>
            </Row>
          </div>
        </Section>

        <Section
          title={t('Синхронизация')}
          footnote={t('Задачи, заметки, цели и финансы на всех ваших устройствах. Содержимое шифруется на устройстве — на сервере только шифротекст.')}
        >
          <SyncSection />
        </Section>

        <Section
          title={t('Данные')}
          footnote={t('Копия переживает потерю телефона. Синхронизация держит устройства в одном состоянии.')}
        >
          <div className="card">
            <Link
              to="/more/settings/backup"
              className="flex min-h-11 items-center gap-2 border-t border-hairline px-4 py-2.5 active:bg-surface-2"
            >
              <span className="flex-1">{t('Копии и восстановление')}</span>
              <BackupStatus />
              <ChevronRight size={ICON.action} className="shrink-0 text-muted" />
            </Link>
          </div>
        </Section>

        <Section
          title={t('Приложение')}
          footnote={t('Версия {v} · данные хранятся только на этом устройстве', { v: APP_VERSION })}
        >
          <div className="card">
            <LinkRow icon={SlidersHorizontal} label={t('Разделы')} to="/more/settings/sections" />
            {/* Раздел ИИ за флагом: пока фича дописывается, её можно мержить в
                main рабочего приложения, не показывая на «Главной».
                Переключатель вместо сегментов «Скрыт / Показать»: это выбор из
                двух состояний одного и того же, а не выбор варианта. */}
            <Row icon={Bot} label={t('Раздел «ИИ»')}>
              <Switch
                checked={Boolean(settings.aiEnabled)}
                onChange={(on) => void updateSettings({ aiEnabled: on })}
                label={t('Раздел «ИИ»')}
              />
            </Row>
            {/* Группировка временных задач. По умолчанию включена и при этом
                незаметна: пока ни одна задача не помечена временной, разделять
                нечего. Выключатель — для тех, кто так о задачах не думает:
                навязанная группировка в чужой голове только мешает. */}
            <Row icon={ListChecks} label={t('Временные задачи отдельно')}>
              <Switch
                checked={settings.groupTemporary !== false}
                onChange={(on) => void updateSettings({ groupTemporary: on })}
                label={t('Временные задачи отдельно')}
              />
            </Row>
            <LinkRow icon={Trash2} label={t('Корзина')} to="/more/trash" />
            {/* Только тур. Подсказки — отдельной строкой ниже: раньше одна
                кнопка делала два дела, и человек, которому нужен был тур,
                заодно получал обратно все скрытые советы. */}
            <ButtonRow
              icon={GraduationCap}
              label={t('Обучение')}
              action={t('Показать заново')}
              onClick={() => void updateSettings({ onboardingDone: null })}
            />
            <HintsResetRow />
            <LinkRow label={t('Установка и восстановление')} to="/more/settings/install" />
            {/* Версия — из changelog, а не хардкод: прежняя строка «1.0.0»
                застыла навсегда и врала. Тап открывает окно «Что нового»
                (сброс lastSeenVersion — WhatsNew сам покажется). */}
            <ButtonRow
              label={t('Что нового')}
              action={t('Открыть')}
              onClick={() => void updateSettings({ lastSeenVersion: '' })}
            />
          </div>
        </Section>
      </div>
    </Screen>
  );
}
