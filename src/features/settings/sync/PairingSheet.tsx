import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  GCheck as Check,
  GCopy as Copy,
} from '../../../components/ui/glyphs';
import { Sheet } from '../../../components/ui/Sheet';
import { Button } from '../../../components/ui/Button';
import { SegmentedControl } from '../../../components/ui/SegmentedControl';
import { startPairing, awaitPairing, connectSync, runSync } from '../../../lib/sync';
import { extractRecoveryCode } from '../../../lib/recoveryKey';
import { t } from '../../../lib/i18n';
import { ICON } from '../../../components/ui/icons';

interface Props {
  open: boolean;
  mode: 'show' | 'connect';
  onClose: () => void;
  onConnected?: () => void;
}

const SCAN_TABS = [
  { value: 'scan' as const, label: 'Сканировать' },
  { value: 'paste' as const, label: 'Вставить ключ' },
];

/** Диалог сопряжения устройств: показать свой QR/код (mode='show') либо
 *  подключиться к существующему аккаунту сканом/вводом (mode='connect'). */
export function PairingSheet({ open, mode, onClose, onConnected }: Props) {
  // --- show ---
  // code — код ВСТРЕЧИ для QR: секретов не содержит, живёт 15 минут и гаснет
  // после первого получения. Ключ восстановления здесь больше не показывается
  // — у него свой экран, RecoveryKeySheet.
  const [code, setCode] = useState('');
  const [qrUrl, setQrUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [paired, setPaired] = useState(false);
  // --- connect ---
  const [tab, setTab] = useState<'scan' | 'paste'>('scan');
  const [pasteVal, setPasteVal] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);

  // Подключение через ref, обновляемый в эффекте — стабильная ссылка для
  // камеры-эффекта (присваивать ref в теле рендера линтер запрещает).
  const connectRef = useRef<(raw: string) => void>(() => {});
  useEffect(() => {
    connectRef.current = (raw: string) => {
      if (busy) return;
      setBusy(true);
      setError('');
      // extractRecoveryCode: человек вставляет то, что у него в руках, — а в
      // руках у него файл ключа целиком, с шапкой и переносами. Раньше поле
      // принимало только голый код и на всё отвечало «проверьте код».
      void connectSync(extractRecoveryCode(raw))
        .then(() => runSync())
        .then(() => {
          onConnected?.();
          onClose();
        })
        .catch((e: unknown) => {
          // Движок различает «код использован», «код устарел», «нет связи» и
          // «аккаунт не найден» — и все эти тексты схлопывались в один общий,
          // после которого человек по кругу пересканировал мёртвый QR.
          const why = e instanceof Error && e.message ? e.message : '';
          setError(why || t('Не удалось подключить. Проверьте код и попробуйте снова.'));
          setBusy(false);
        });
    };
  });

  // show: открыть встречу, нарисовать QR и дождаться второго устройства.
  //
  // Ожидание идёт само, пока экран открыт: человек показывает QR, сканирует на
  // втором телефоне и видит здесь галочку. Нажимать ничего не нужно — порядок
  // действий ровно тот же, что был с прежним кодом.
  useEffect(() => {
    if (!(open && mode === 'show')) return;
    const signal = { aborted: false };
    // Сброс отметки — внутри цепочки, а не синхронно в теле эффекта: иначе
    // линтер справедливо ругается на каскад перерисовок.
    void startPairing().then(async (meet) => {
      if (!meet || signal.aborted) return;
      setPaired(false);
      setCode(meet.code);
      setQrUrl(await QRCode.toDataURL(meet.code, { margin: 1, width: 260 }));
      const ok = await awaitPairing(meet.pairId, meet.priv, signal);
      if (!signal.aborted && ok) setPaired(true);
    });
    return () => {
      signal.aborted = true;
    };
  }, [open, mode]);

  // connect/scan: запустить камеру и искать QR в кадрах
  useEffect(() => {
    if (!(open && mode === 'connect' && tab === 'scan')) return;
    let cancelled = false;
    const stopCamera = () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const tick = () => {
          if (cancelled) return;
          if (v.readyState >= v.HAVE_ENOUGH_DATA && v.videoWidth) {
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const found = jsQR(img.data, img.width, img.height);
            if (found?.data) {
              cancelled = true;
              stopCamera();
              connectRef.current(found.data);
              return;
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        setError(t('Нет доступа к камере. Вставьте код вручную.'));
        setTab('paste');
      }
    })();
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [open, mode, tab]);

  function copyCode() {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <Sheet open={open} onClose={onClose} title={mode === 'show' ? t('Код для другого устройства') : t('Подключить по ключу')}>
      {mode === 'show' ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {t('Отсканируйте этот QR на втором устройстве (Настройки → Синхронизация → Подключить).')}
          </p>
          {paired ? (
            <p className="flex items-center justify-center gap-2 text-sm font-semibold text-success">
              <Check size={ICON.base} />
              {t('Устройство подключено')}
            </p>
          ) : (
            <p className="text-center text-xs text-muted">{t('Код действует 15 минут и только один раз')}</p>
          )}
          {qrUrl && (
            <div className="flex justify-center">
              <img src={qrUrl} alt={t('QR-код сопряжения')} className="rounded-2xl bg-white p-3" width={260} height={260} />
            </div>
          )}
          {/* Здесь только одноразовый код встречи. Ключ восстановления живёт
              на своём экране (RecoveryKeySheet): рядом эти две кнопки
              выглядели одинаково, хотя одна даёт 15 минут, а другая —
              вечный доступ ко всем данным. */}
          <Button variant="secondary" className="w-full inline-flex items-center justify-center gap-2" onClick={copyCode}>
            {copied ? <Check size={ICON.base} /> : <Copy size={ICON.base} />}
            {copied ? t('Скопировано') : t('Скопировать код')}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <SegmentedControl
            options={SCAN_TABS.map((o) => ({ ...o, label: t(o.label) }))}
            value={tab}
            onChange={setTab}
          />
          {tab === 'scan' ? (
            <div className="space-y-2">
              <div className="overflow-hidden rounded-2xl bg-black">
                <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
              </div>
              <p className="text-center text-sm text-muted">{t('Наведите камеру на QR-код первого устройства')}</p>
            </div>
          ) : (
            <div className="space-y-2">
              <textarea
                value={pasteVal}
                onChange={(e) => setPasteVal(e.target.value)}
                placeholder={t('Вставьте ключ восстановления или код с другого устройства')}
                rows={4}
                className="w-full rounded-xl border border-border bg-surface p-3 font-mono text-xs"
              />
              <Button
                className="w-full"
                disabled={!pasteVal.trim() || busy}
                onClick={() => connectRef.current(pasteVal)}
              >
                {busy ? t('Подключаю…') : t('Подключить')}
              </Button>
            </div>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}
    </Sheet>
  );
}
