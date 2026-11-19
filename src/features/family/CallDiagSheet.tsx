import { format } from 'date-fns';
import { Sheet } from '../../components/ui/Sheet';
import { getCallDiag, type CallDiag } from '../../lib/family/familyCall';
import { getLang, t } from '../../lib/i18n';
import { dateLocale } from '../../lib/dates';

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
          {/* Дата — чтобы свежий разбор не путать с прошлым звонком. */}
          <Row
            label={t('Когда')}
            value={format(new Date(d.at), getLang() === 'ru' ? 'd MMMM, HH:mm' : 'MMMM d, HH:mm', { locale: dateLocale() })}
          />
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
                      : `${t('сервер вернул только STUN')}${d.turnDetail ? ` · ${d.turnDetail}` : ''}`
            }
            bad={d.turn !== 'ok'}
          />
          <Row label={t('Свои маршруты')} value={fmtCands(d.local, d.relayVia)} bad={!d.local.relay} />
          <Row label={t('Маршруты собеседника')} value={fmtCands(d.remote)} bad={!d.remote.relay} />
          {d.pair && <Row label={t('Выбранная пара')} value={d.pair} />}
          {/* Отвечает на вопрос, дошёл ли трафик звонка до собеседника вообще. */}
          {d.checks && (
            <Row
              label={t('Проверки маршрутов')}
              value={t('отправлено {sent} · ответов {recv}', { sent: d.checks.sent, recv: d.checks.recv })}
              bad={!d.checks.recv}
            />
          )}
          {d.dtls && <Row label={t('Защищённый канал')} value={fmtDtls(d.dtls)} bad={d.dtls !== 'connected'} />}
          {!!d.restarts && (
            <Row label={t('Попыток восстановить')} value={String(d.restarts)} />
          )}
          {!!d.iceErrors?.length && (
            <Row label={t('Отказы ретранслятора')} value={d.iceErrors.join(', ')} bad />
          )}

          <p className="rounded-xl bg-lh-surface-2 p-3 text-xs leading-relaxed text-lh-text-secondary">
            {verdict(d)}
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
function fmtCands(c: Record<string, number>, via?: string[]): string {
  const total = Object.values(c).reduce((s, n) => s + n, 0);
  if (!total) return t('нет');
  // Через что ретранслятор ответил (udp / tcp / tls) — видно, какой путь сеть пускает.
  return c.relay ? `${t('есть ретранслятор')}${via?.length ? ` · ${via.join(', ')}` : ''}` : t('только прямые');
}

/** Состояние защищённого канала звонка (DTLS) словами. */
function fmtDtls(s: string): string {
  if (s === 'connected') return t('установлен');
  if (s === 'failed') return t('не установился');
  if (s === 'connecting') return t('устанавливался');
  return t('не начинался');
}

function verdict(d: CallDiag): string {
  const turnOk = d.turn === 'ok';
  const localRelay = !!d.local.relay;
  const remoteRelay = !!d.remote.relay;
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
  // Соединения за звонок не было вовсе — «обрыв во время разговора» был бы
  // неправдой. Разбираем, на каком шаге встало.
  if (d.connected === false) {
    if (!d.checks?.recv) {
      return t(
        'Маршруты собраны с обеих сторон, но проверки до собеседника остались без ответа: сеть не пропускает трафик звонка ни напрямую, ни через этот ретранслятор. Поможет ретранслятор, до которого эта сеть пускает.',
      );
    }
    return t(
      'Маршрут до собеседника нашёлся, но защищённый канал звонка не установился — похоже, сеть режет сами звонки, а не адреса. Обойти это может ретранслятор по TLS на порту 443.',
    );
  }
  return t(
    'Маршруты были с обеих сторон — обрыв случился уже во время разговора. Обычно это скачок мобильной сети; при повторе связь подхватывается сама.',
  );
}
