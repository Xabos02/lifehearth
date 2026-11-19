// Две настройки, от которых зависит, дозвонится ли человек с мобильного
// интернета и во что ему обойдётся разговор. Держим их отдельно от менеджера
// звонков: это чистые преобразования текста, их можно проверить точно.

/**
 * Opus по умолчанию шлёт тишину теми же пакетами, что и речь.
 *
 * `usedtx=1` включает паузы: в молчании поток почти прекращается — это
 * заметная экономия мобильного трафика и батареи. `maxaveragebitrate=32000`
 * держит расход предсказуемым; для голоса это прозрачное качество (RFC 7587
 * относит к fullband-речи 28–40 кбит/с).
 *
 * Тонкость, на которой ошибаются чаще всего: параметры Opus в SDP описывают
 * возможности ПРИЁМНИКА, то есть написанное в нашем описании читает кодировщик
 * собеседника. Поэтому правку применяют и к своему описанию, и к описанию
 * собеседника — так делают Jitsi и клиент Matrix.
 *
 * Чужие значения не перетираем: если параметр уже задан, он выбран осознанно.
 */
export function tuneOpusSdp(sdp: string | undefined): string | undefined {
  if (!sdp) return sdp;
  return sdp.replace(/^a=fmtp:(\d+) (.*(?:useinbandfec|minptime).*)$/gm, (_line, pt, params) => {
    let p = params as string;
    if (!/usedtx=/.test(p)) p += ';usedtx=1';
    if (!/maxaveragebitrate=/.test(p)) p += ';maxaveragebitrate=32000';
    return `a=fmtp:${pt as string} ${p}`;
  });
}

/**
 * Порядок адресов ретранслятора решает, пройдёт ли звонок по плохой сети.
 *
 * Первым ставим TLS на 443: такой трафик неотличим от обычного HTTPS и
 * проходит там, где душат UDP (мобильные сети) или режет корпоративный
 * фаервол. Дальше — UDP, он лучше по задержке, когда доступен. Порт 53
 * выбрасываем: Cloudflare сама предупреждает, что его блокируют и провайдеры,
 * и браузеры.
 *
 * Cloudflare отдаёт TLS на 5349; тот же ретранслятор слушает и 443, поэтому
 * адрес на 443 добавляем явно — именно он проходит везде.
 */
export function orderTurnUrls(urls: string[]): string[] {
  const kept = urls.filter((u) => typeof u === 'string' && !/:53(\?|$)/.test(u));
  // Запасные порты Cloudflare: по документации TURN тот же ретранслятор
  // слушает 443/udp рядом с 3478/udp и 80/tcp рядом с 3478/tcp. В выдаче
  // ключа их нет, а сеть, которая режет 3478, их может пропустить.
  for (const u of [...kept]) {
    const m = /^turn:(turn\.cloudflare\.com):3478\?transport=(udp|tcp)$/.exec(u);
    if (!m) continue;
    const alt = `turn:${m[1]}:${m[2] === 'udp' ? 443 : 80}?transport=${m[2]}`;
    if (!kept.includes(alt)) kept.push(alt);
  }
  const rank = (u: string) => {
    if (u.startsWith('turns:') && u.includes(':443')) return 0;
    if (u.startsWith('turns:')) return 1;
    if (u.startsWith('turn:') && u.includes('udp')) return 2;
    if (u.startsWith('turn:')) return 3;
    return 4; // stun — в конце: он уже есть отдельной записью
  };
  const ordered = [...kept].sort((a, b) => rank(a) - rank(b));
  if (!ordered.some((u) => u.startsWith('turns:') && u.includes(':443'))) {
    const anyTls = ordered.find((u) => u.startsWith('turns:'));
    if (anyTls) ordered.unshift(anyTls.replace(/:\d+/, ':443'));
  }
  return ordered;
}
