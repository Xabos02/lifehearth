import { Sheet } from '../../components/ui/Sheet';
import { getCallDiag } from '../../lib/family/familyCall';
import { t } from '../../lib/i18n';

/** Разбор последнего неудавшегося звонка.
 *
 *  До этого экрана «Соединение потеряно» было единственным, что видел человек,
 *  и за этой фразой пряталось несколько разных причин: не пришли TURN-креды,
 *  сеть не выпустила relay, оборвался сигналинг. Здесь — факты того звонка
 *  человеческим языком, без консоли и без переписки со мной. */
export function CallDiagSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const d = getCallDiag();

  return (
    <Sheet open={open} onClose={onClose} title={t('Почему звонок не вышел')}>
      {!d ? (
        <p className="py-6 text-center text-sm text-lh-text-secondary">
          {t('Неудачных звонков пока не было.')}
        </p>
      ) : (
        <div className="space-y-4">
          <Row label={t('Что произошло')} value={t(d.reason)} />
          <Row
            label={t('Ретранслятор (TURN)')}
            value={
              d.turn === 'ok'
                ? t('получен')
                : d.turn === 'no-config'
                  ? t('нет доступа к группе')
                  : d.turn === 'http-error'
                    ? `${t('сервер отказал')} · ${d.turnDetail ?? ''}`
                    : d.turn === 'network-error'
                      ? t('сеть не пустила запрос')
                      : t('сервер вернул только STUN')
            }
            bad={d.turn !== 'ok'}
          />
          <Row label={t('Свои маршруты')} value={fmtCands(d.local)} bad={!d.local.relay} />
          <Row label={t('Маршруты собеседника')} value={fmtCands(d.remote)} bad={!d.remote.relay} />
          {d.pair && <Row label={t('Выбранная пара')} value={d.pair} />}
          {!!d.restarts && (
            <Row label={t('Попыток восстановить')} value={String(d.restarts)} />
          )}
          {!!d.iceErrors?.length && (
            <Row label={t('Отказы ретранслятора')} value={d.iceErrors.join(', ')} bad />
          )}

          <p className="rounded-xl bg-lh-surface-2 p-3 text-xs leading-relaxed text-lh-text-secondary">
            {verdict(d.turn === 'ok', !!d.local.relay, !!d.remote.relay)}
          </p>
        </div>
      )}
    </Sheet>
  );
}

function Row({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-sm text-lh-text-secondary">{label}</span>
      <span className={`min-w-0 text-right text-sm font-medium ${bad ? 'text-warning' : ''}`}>
        {value}
      </span>
    </div>
  );
}

/** host — своя сеть, srflx — через STUN, relay — через ретранслятор. Человеку
 *  важно одно: есть ли relay, потому что без него мобильная сеть не пробивается. */
function fmtCands(c: Record<string, number>): string {
  const total = Object.values(c).reduce((s, n) => s + n, 0);
  if (!total) return t('нет');
  return c.relay ? t('есть ретранслятор') : t('только прямые');
}

function verdict(turnOk: boolean, localRelay: boolean, remoteRelay: boolean): string {
  if (!turnOk) {
    return t(
      'Устройство не получило ретранслятор от сервера. На мобильном интернете без него звонок почти всегда обрывается — проверьте связь и попробуйте снова.',
    );
  }
  if (!localRelay) {
    return t(
      'Ретранслятор выдан, но сеть не дала до него достучаться. Так бывает в корпоративных и гостевых сетях с жёстким фаерволом — попробуйте другую сеть.',
    );
  }
  if (!remoteRelay) {
    return t(
      'С вашей стороны всё в порядке: маршруты собраны. Не хватило маршрутов собеседника — проблема на его стороне, ему стоит открыть этот же разбор у себя.',
    );
  }
  return t(
    'Маршруты были с обеих сторон — обрыв случился уже во время разговора. Обычно это скачок мобильной сети; при повторе связь подхватывается сама.',
  );
}
