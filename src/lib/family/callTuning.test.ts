// Настройка звука и порядок адресов ретранслятора — две правки, от которых
// зависит, дозвонится ли человек с мобильного интернета и сколько трафика
// съест разговор. Обе — чистые преобразования текста, проверяются точно.

import { describe, expect, it } from 'vitest';
import { tuneOpusSdp } from './callTuning';
import { orderTurnUrls } from './callTuning';

const SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=setup:actpass',
].join('\r\n');

describe('настройка Opus', () => {
  it('включает паузы в тишине и держит потолок битрейта', () => {
    const out = tuneOpusSdp(SDP)!;
    expect(out).toContain('usedtx=1');
    expect(out).toContain('maxaveragebitrate=32000');
    // Существующие параметры не теряются.
    expect(out).toContain('useinbandfec=1');
    expect(out).toContain('minptime=10');
  });

  it('не дублирует то, что уже задано', () => {
    const already = SDP.replace('useinbandfec=1', 'useinbandfec=1;usedtx=1;maxaveragebitrate=24000');
    const out = tuneOpusSdp(already)!;
    expect(out.match(/usedtx=/g)).toHaveLength(1);
    // Чужое значение не перетираем: раз оно уже выбрано — значит осознанно.
    expect(out).toContain('maxaveragebitrate=24000');
  });

  it('описание без Opus возвращается нетронутым', () => {
    const video = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000';
    expect(tuneOpusSdp(video)).toBe(video);
    expect(tuneOpusSdp(undefined)).toBeUndefined();
  });
});

describe('порядок адресов ретранслятора', () => {
  const raw = [
    'stun:stun.cloudflare.com:3478',
    'turn:turn.cloudflare.com:3478?transport=udp',
    'turn:turn.cloudflare.com:3478?transport=tcp',
    'turns:turn.cloudflare.com:5349?transport=tcp',
  ];

  it('TLS-адрес идёт первым — он проходит там, где душат UDP', () => {
    const out = orderTurnUrls(raw);
    expect(out[0].startsWith('turns:')).toBe(true);
    // И это именно 443: порт, неотличимый от обычного HTTPS.
    expect(out[0]).toContain(':443');
  });

  it('UDP остаётся в списке — он быстрее, когда доступен', () => {
    const out = orderTurnUrls(raw);
    expect(out.some((u) => u.includes('transport=udp'))).toBe(true);
  });

  it('запасные порты Cloudflare добавляются: 443/udp и 80/tcp, без дублей', () => {
    const out = orderTurnUrls(raw);
    expect(out).toContain('turn:turn.cloudflare.com:443?transport=udp');
    expect(out).toContain('turn:turn.cloudflare.com:80?transport=tcp');
    // Уже присланный запасной порт не дублируется.
    const twice = orderTurnUrls([...raw, 'turn:turn.cloudflare.com:443?transport=udp']);
    expect(twice.filter((u) => u === 'turn:turn.cloudflare.com:443?transport=udp')).toHaveLength(1);
    // Чужим ретрансляторам порты не выдумываем.
    expect(orderTurnUrls(['turn:relay.example.com:3478?transport=udp'])).toHaveLength(1);
  });

  it('порт 53 выбрасывается — его режут провайдеры и браузеры', () => {
    const out = orderTurnUrls([...raw, 'turn:turn.cloudflare.com:53?transport=udp']);
    // Именно порт 53, а не любое вхождение «53»: 5349 — легальный TLS-порт.
    expect(out.some((u) => /:53(\?|$)/.test(u))).toBe(false);
    expect(out.length).toBeGreaterThan(0);
  });
});
