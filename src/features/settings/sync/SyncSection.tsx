import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  RefreshCw,
  QrCode,
  Smartphone,
  ShieldCheck,
  KeyRound,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { useToast } from '../../../components/ui/toastContext';
import { db } from '../../../db/db';
import { getSyncConfig, patchSyncConfig } from '../../../lib/syncState';
import { createSyncAccount, disableSync, runSync } from '../../../lib/sync';
import { PairingSheet } from './PairingSheet';
import { RecoveryKeySheet } from './RecoveryKeySheet';
import { t } from '../../../lib/i18n';
import { ICON } from '../../../components/ui/icons';
import {
  GCopy as Copy,
} from '../../../components/ui/glyphs';

function formatSyncedAt(iso: string): string {
  if (!iso) return t('ещё не синхронизировано');
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SyncSection() {
  const config = useLiveQuery(() => getSyncConfig(), []);
  const toast = useToast();
  // Отметку о неудаче ставит фоновый цикл — читаем её живым запросом, чтобы
  // строка исчезла сама, как только обмен пройдёт.
  const failedAt = useLiveQuery(async () => (await db.settings.get('app'))?.syncFailedAt ?? null, []);
  const failedReason = useLiveQuery(
    async () => (await db.settings.get('app'))?.syncFailedReason ?? null,
    [],
  );
  // Записи, которые сервер не примет никогда (сейчас это задачи с десятком
  // фотографий: снимки лежат прямо в строке задачи). Обмен из-за них больше не
  // встаёт, но человек должен знать, что эти задачи живут только здесь.
  const oversized = useLiveQuery(async () => (await db.settings.get('app'))?.syncOversized ?? 0, []);
  const [sheet, setSheet] = useState<null | 'show' | 'connect'>(null);
  const [keySheet, setKeySheet] = useState(false);
  // Ключ сохранён — только если человек вставил сохранённое обратно и оно
  // совпало. Скачанный файл этого не доказывает: он уходил и пустым, и не туда.
  const keySavedAt = useLiveQuery(
    async () => (await db.settings.get('app'))?.recoveryKeySavedAt ?? null,
    [],
  );
  const [busy, setBusy] = useState(false);

  async function handleCreate() {
    if (busy) return;
    setBusy(true);
    try {
      await createSyncAccount();
      await runSync().catch(() => {});
      toast(t('Синхронизация включена'));
      // Сразу — ключ, а не QR. Раньше здесь открывался «Код для другого
      // устройства»: человек с одним телефоном закрывал его не читая и
      // оставался с облачными данными, которые нечем вернуть.
      setKeySheet(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncNow() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await runSync();
      // Пропущенные — «ядовитые» записи (битый шифротекст): цикл жив, но о
      // проблеме надо сказать, иначе потерю данных не заметить.
      if (r && r.skipped > 0) toast(t('Синхронизировано · получено {pulled}, отправлено {pushed}, пропущено {skipped}', { pulled: r.pulled, pushed: r.pushed, skipped: r.skipped }));
      else if (r) toast(t('Синхронизировано · получено {pulled}, отправлено {pushed}', { pulled: r.pulled, pushed: r.pushed }));
    } catch {
      toast(t('Не удалось синхронизировать. Проверьте связь и попробуйте ещё раз'));
    } finally {
      setBusy(false);
    }
  }

  /** Перечитать всё заново: сбросить курсоры и прогнать полный круг.
   *
   *  Аварийный выход для состояния «обмен идёт успешно, а данные не ходят».
   *  Курсоры — единственное, что помнит устройство между кругами, и именно
   *  они ломаются незаметно: уехали в будущее — и сервер честно отвечает
   *  «нового нет» на каждый запрос. Защита от этого теперь стоит в самом
   *  обмене, но кнопка нужна и на случай причин, до которых защита не
   *  добралась: сбрасывать нечего, кроме этих двух меток, а данные при этом
   *  не теряются — записи применяются только если свежее локальных.
   */
  async function handleResync() {
    if (busy) return;
    if (
      !window.confirm(
        t('Перечитать всё заново? Приложение заново отправит и получит все записи. Ничего не потеряется — это займёт больше времени, чем обычный обмен.'),
      )
    )
      return;
    setBusy(true);
    try {
      await patchSyncConfig({ lastPullAt: '', lastPushAt: '' });
      const r = await runSync();
      if (r) toast(t('Синхронизировано · получено {pulled}, отправлено {pushed}', { pulled: r.pulled, pushed: r.pushed }));
    } catch {
      toast(t('Не удалось синхронизировать. Проверьте связь и попробуйте ещё раз'));
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyAccount() {
    if (!config) return;
    try {
      await navigator.clipboard.writeText(config.accountId);
      toast(t('ID аккаунта скопирован'));
    } catch {
      // Клипборд недоступен (нет secure context / отказ WebKit) — показываем
      // значение в prompt, откуда его можно выделить и скопировать вручную.
      window.prompt(t('ID аккаунта — скопируйте вручную:'), config.accountId);
    }
  }

  async function handleDisable() {
    // Отключение стирает конфиг целиком, вместе с единственной копией ключа:
    // после него облачная копия превращается в нечитаемый шифротекст. Прежний
    // текст обещал ровно обратное — «локальные данные останутся на месте».
    if (
      !window.confirm(
        keySavedAt
          ? t('Отключить синхронизацию на этом устройстве? Записи на телефоне останутся. Ключ с телефона будет стёрт — вернуть облако можно будет только сохранённым файлом ключа.')
          : t('Отключить синхронизацию? Ключ восстановления НЕ сохранён, а отключение стирает его с телефона: облачные записи после этого не вернуть ничем. Сначала сохраните ключ.'),
      )
    )
      return;
    await disableSync();
    toast(t('Синхронизация отключена'));
  }

  return (
    <>
      <div className="space-y-3 card p-4">
        {config ? (
          <>
            <p className="flex items-center gap-2 text-sm">
              <ShieldCheck size={ICON.base} className="shrink-0 text-success" />
              <span>
                <span className="font-medium text-success">{t('Включена')}</span> · {t('E2E-шифрование')}
                <br />
                <span className="text-muted">{t('Последняя: {when}', { when: formatSyncedAt(config.lastSyncedAt) })}</span>
                {!!oversized && (
                  <>
                    <br />
                    <span className="text-warning">
                      {t('Не уезжает записей: {n} — слишком тяжёлые. Обычно это задача с фотографиями: часть снимков лучше положить в заметку.', {
                        n: oversized,
                      })}
                    </span>
                  </>
                )}
                {failedAt && (
                  <>
                    <br />
                    {/* Фоновый обмен идёт сам и об ошибках молчал: он мог не
                        работать неделями, а здесь стояла просто старая дата. */}
                    <span className="text-warning">
                      {failedReason
                        ? t('Последняя попытка не удалась ({when}): {why}', {
                            when: formatSyncedAt(failedAt),
                            why: failedReason,
                          })
                        : t('Последняя попытка не удалась: {when}', {
                            when: formatSyncedAt(failedAt),
                          })}
                    </span>
                  </>
                )}
              </span>
            </p>
            {/* Пока ключ не сохранён, человек находится в состоянии «данные в
                облаке есть, а вернуть их нечем» — и до этой правки не знал об
                этом вовсе: экран показывал зелёное «Включена · E2E-шифрование».
                Строка висит здесь, пока сохранность не подтверждена вставкой. */}
            {!keySavedAt && (
              <button
                className="flex w-full items-start gap-2 rounded-xl bg-warning/10 p-3 text-left text-sm text-warning active:opacity-60"
                onClick={() => setKeySheet(true)}
              >
                <KeyRound size={ICON.base} className="mt-0.5 shrink-0" />
                <span>
                  {t('Ключ восстановления не сохранён. Без него записи из облака не вернуть — сохраните файл сейчас.')}
                </span>
              </button>
            )}
            <Button className="w-full inline-flex items-center justify-center gap-2" disabled={busy} onClick={() => void handleSyncNow()}>
              <RefreshCw size={ICON.base} className={busy ? 'animate-spin' : ''} />
              {t('Синхронизировать сейчас')}
            </Button>
            <Button
              variant="secondary"
              className="w-full inline-flex items-center justify-center gap-2"
              onClick={() => setKeySheet(true)}
            >
              <KeyRound size={ICON.base} />
              {keySavedAt ? t('Ключ восстановления · сохранён') : t('Сохранить ключ восстановления')}
            </Button>
            <Button
              variant="secondary"
              className="w-full inline-flex items-center justify-center gap-2"
              onClick={() => setSheet('show')}
            >
              <QrCode size={ICON.base} />
              {t('Показать QR для другого устройства')}
            </Button>
            <Button
              variant="secondary"
              className="w-full inline-flex items-center justify-center gap-2"
              onClick={() => setSheet('connect')}
            >
              <Smartphone size={ICON.base} className="shrink-0" />
              {t('У меня уже есть данные — подключить по ключу')}
            </Button>
            <button
              className="w-full text-sm text-muted active:opacity-60"
              disabled={busy}
              onClick={() => void handleResync()}
            >
              {t('Перечитать всё заново')}
            </button>
            {/* ID аккаунта нужен для allowlist AI-прокси в Worker (AI_ALLOWED_ACCOUNTS):
                значение вводится в дашборде Cloudflare руками, поэтому кнопка копирования. */}
            <button
              className="flex w-full items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-left active:opacity-60"
              onClick={() => void handleCopyAccount()}
            >
              <span className="min-w-0">
                <span className="block text-xs text-muted">{t('ID аккаунта')}</span>
                <span className="block font-mono text-xs break-all">{config.accountId}</span>
              </span>
              <Copy size={ICON.action} className="shrink-0 text-muted" />
            </button>
            {/* Самая частая причина «данные не появляются» — устройства в
                РАЗНЫХ аккаунтах: синхронизация настраивается на каждом
                отдельно, и после переустановки приложения её надо подключить
                заново. Понять это по одному лишь ID было невозможно: он тут
                стоял без единого слова о том, зачем он и с чем его сверять. */}
            <p className="text-xs leading-snug text-muted">
              {t('Этот ID должен совпадать на всех ваших устройствах: разный ID — разные аккаунты, и данные между ними не ходят. Хранить ID не нужно — он лежит внутри ключа восстановления.')}
            </p>
            <button
              className="w-full pt-1 text-sm text-danger active:opacity-60"
              onClick={() => void handleDisable()}
            >
              {t('Отключить синхронизацию')}
            </button>
          </>
        ) : (
          <>
            {/* Объяснение переехало сноской под группу (SettingsPage): абзац
                внутри карточки занимал 87px над кнопками, ради которых сюда и
                заходят. */}
            <Button className="w-full" disabled={busy} onClick={() => void handleCreate()}>
              {t('Включить синхронизацию')}
            </Button>
            <Button
              variant="secondary"
              className="w-full inline-flex items-center justify-center gap-2"
              onClick={() => setSheet('connect')}
            >
              <Smartphone size={ICON.base} className="shrink-0" />
              {t('У меня уже есть данные — подключить по ключу')}
            </Button>
          </>
        )}
      </div>

      <RecoveryKeySheet open={keySheet} saved={Boolean(keySavedAt)} onClose={() => setKeySheet(false)} />

      <PairingSheet
        open={sheet !== null}
        mode={sheet === 'connect' ? 'connect' : 'show'}
        onClose={() => setSheet(null)}
        onConnected={() => toast(t('Устройство подключено'))}
      />
    </>
  );
}
