// Иллюстрации слайдов обучения. Один стиль: тонкий серебристый штрих
// (currentColor), тёплое свечение очага снизу — как у иконки приложения.
// Здесь чистый SVG для канвы; в приложение переносится в TSX 1:1.
const S = 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"';
const glow = (cx = 80, cy = 122, r = 46) => `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r * 0.42}" fill="url(#ember)" opacity="0.9"/>`;
const ember = (x, y, r = 1.6, o = 0.9) => `<circle cx="${x}" cy="${y}" r="${r}" fill="var(--ember-2)" opacity="${o}"/>`;
// Очаг — как на иконке: полено-полоса и угли на ней. Общий знак приложения.
const hearth = (cx, cy) => `<rect x="${cx - 22}" y="${cy - 4}" width="44" height="8" rx="4" fill="var(--ember)" fill-opacity="0.55" stroke="var(--ember-2)" stroke-opacity="0.6" stroke-width="1"/>
  ${ember(cx - 10, cy, 1.8, 1)}${ember(cx + 2, cy - 1, 1.5, 0.95)}${ember(cx + 12, cy + 1, 1.3, 0.9)}${ember(cx - 3, cy - 12, 1.1, 0.7)}${ember(cx + 8, cy - 16, 0.9, 0.55)}`;
const defs = `<defs>
  <radialGradient id="ember" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="var(--ember)" stop-opacity="0.55"/><stop offset="55%" stop-color="var(--ember)" stop-opacity="0.14"/><stop offset="100%" stop-color="var(--ember)" stop-opacity="0"/></radialGradient>
  <linearGradient id="silver" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="currentColor" stop-opacity="1"/><stop offset="100%" stop-color="currentColor" stop-opacity="0.55"/></linearGradient>
</defs>`;
const wrap = (inner) => `<svg viewBox="0 0 160 160" width="200" height="200" xmlns="http://www.w3.org/2000/svg" style="color:var(--ink)">${defs}${inner}</svg>`;

export const ILLOS = {
  // Сегодня — солнце над линией горизонта, лучи по дуге.
  today: wrap(`${glow(80, 104, 52)}
    <path d="M30 104h100" ${S} stroke="currentColor" opacity="0.5"/>
    <path d="M52 104a28 28 0 0 1 56 0" ${S} stroke="url(#silver)"/>
    <path d="M80 56v-12M50 68l-8-8M110 68l8-8M38 92H26M134 92h-12" ${S} stroke="currentColor" opacity="0.7"/>
    ${ember(72, 100, 1.8)}${ember(90, 98, 1.4, 0.7)}${ember(82, 108, 1.2, 0.6)}`),
  // Задачи — три строки, одна отмечена.
  tasks: wrap(`${glow(80, 126, 44)}
    <circle cx="44" cy="52" r="9" ${S} stroke="url(#silver)"/><path d="M40 52l3 3 6-6" ${S} stroke="currentColor"/>
    <path d="M62 52h56" ${S} stroke="currentColor" opacity="0.85"/>
    <circle cx="44" cy="82" r="9" ${S} stroke="currentColor" opacity="0.6"/><path d="M62 82h44" ${S} stroke="currentColor" opacity="0.5"/>
    <circle cx="44" cy="112" r="9" ${S} stroke="currentColor" opacity="0.4"/><path d="M62 112h50" ${S} stroke="currentColor" opacity="0.35"/>
    ${ember(118, 78, 1.6)}${ember(126, 86, 1.2, 0.7)}`),
  // Заметки — лист с загнутым углом, первая строка толще (она станет названием).
  notes: wrap(`${glow(80, 128, 44)}
    <path d="M48 32h46l18 18v78H48z" ${S} stroke="url(#silver)"/>
    <path d="M94 32v18h18" ${S} stroke="currentColor" opacity="0.7"/>
    <path d="M60 66h40" stroke-width="3" stroke-linecap="round" fill="none" stroke="currentColor"/>
    <path d="M60 82h32M60 96h38M60 110h24" ${S} stroke="currentColor" opacity="0.5"/>
    ${ember(104, 110, 2)}${ember(110, 118, 1.3, 0.7)}`),
  // Цели — вершина с флагом, ступени пути.
  goals: wrap(`${glow(80, 130, 50)}
    <path d="M28 128L64 68l16 22 12-14 40 52" ${S} stroke="url(#silver)"/>
    <path d="M92 76V44" ${S} stroke="currentColor"/><path d="M92 44h22l-6 8 6 8H92" stroke-width="2" stroke-linejoin="round" stroke="currentColor" fill="var(--ember)" fill-opacity="0.25"/>
    <path d="M44 128h72" ${S} stroke="currentColor" opacity="0.4"/>
    ${ember(60, 112, 1.5, 0.7)}${ember(70, 100, 1.2, 0.6)}`),
  // Семья — трое у очага: две большие фигуры и маленькая между ними, огонь снизу.
  family: wrap(`${glow(80, 122, 58)}
    <circle cx="52" cy="58" r="11" ${S} stroke="url(#silver)"/>
    <circle cx="108" cy="58" r="11" ${S} stroke="url(#silver)"/>
    <circle cx="80" cy="76" r="8" ${S} stroke="currentColor"/>
    <path d="M30 108a22 22 0 0 1 44 0" ${S} stroke="currentColor" opacity="0.85"/>
    <path d="M86 108a22 22 0 0 1 44 0" ${S} stroke="currentColor" opacity="0.85"/>
    <path d="M64 112a16 16 0 0 1 32 0" ${S} stroke="currentColor"/>
    ${hearth(80, 128)}`),
  // Ваши данные — щит с замком; свечение мягче: это про спокойствие.
  data: wrap(`${glow(80, 126, 40)}
    <path d="M80 30l36 12v34c0 24-16 40-36 50-20-10-36-26-36-50V42z" ${S} stroke="url(#silver)"/>
    <rect x="68" y="74" width="24" height="20" rx="4" ${S} stroke="currentColor"/>
    <path d="M73 74v-7a7 7 0 0 1 14 0v7" ${S} stroke="currentColor"/>
    ${ember(80, 84, 2)}`),
  // Дальше — просто: искра, три луча, ни одной лишней линии.
  simple: wrap(`${glow(80, 120, 44)}
    <path d="M80 44c2 18 10 26 28 28-18 2-26 10-28 28-2-18-10-26-28-28 18-2 26-10 28-28z" stroke-width="2" stroke-linejoin="round" stroke="url(#silver)" fill="var(--ember)" fill-opacity="0.12"/>
    <path d="M114 44c1 6 3 8 9 9-6 1-8 3-9 9-1-6-3-8-9-9 6-1 8-3 9-9z" ${S} stroke="currentColor" opacity="0.7"/>
    ${ember(48, 104, 1.6, 0.8)}${ember(112, 100, 1.3, 0.7)}`),
};
