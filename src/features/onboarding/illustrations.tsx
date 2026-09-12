import type { ReactNode } from "react";

// Иллюстрации слайдов обучения. Один стиль на все: тонкий серебристый штрих
// (currentColor, в тёмной теме почти белый, в светлой — графит) и тёплое
// свечение очага снизу — тот же язык, что у иконки приложения («L» над углями).
// Вектор, а не картинки: красится под тему, не размывается на Retina, весит
// килобайты. Исходники и сравнение вариантов — design/onboarding/ (канва
// «Обучение — картинки слайдов»).
//
// Цвета через переменные, которые ставит обёртка слайда (OnboardingOverlay):
// --ember / --ember-2 — угли, currentColor — штрих.

function Frame({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 160 160" className="onb-illo" aria-hidden>
      <defs>
        <radialGradient id="onb-ember" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--ember)" stopOpacity="0.55" />
          <stop offset="55%" stopColor="var(--ember)" stopOpacity="0.14" />
          <stop offset="100%" stopColor="var(--ember)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="onb-silver" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="1" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      {children}
    </svg>
  );
}

/** Today */
export function TodayIllo() {
  return (
    <Frame>
      <ellipse
        cx="80"
        cy="104"
        rx="52"
        ry="21.84"
        fill="url(#onb-ember)"
        opacity="0.9"
      />
      <path
        d="M30 104h100"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
        opacity="0.5"
      />
      <path
        d="M52 104a28 28 0 0 1 56 0"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="url(#onb-silver)"
      />
      <path
        d="M80 56v-12M50 68l-8-8M110 68l8-8M38 92H26M134 92h-12"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
        opacity="0.7"
      />
      <circle cx="72" cy="100" r="1.8" fill="var(--ember-2)" opacity="0.9" />
      <circle cx="90" cy="98" r="1.4" fill="var(--ember-2)" opacity="0.7" />
      <circle cx="82" cy="108" r="1.2" fill="var(--ember-2)" opacity="0.6" />
    </Frame>
  );
}

/** Tasks */
export function TasksIllo() {
  return (
    <Frame>
      <ellipse
        cx="80"
        cy="126"
        rx="44"
        ry="18.48"
        fill="url(#onb-ember)"
        opacity="0.9"
      />
      <circle
        cx="44"
        cy="52"
        r="9"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="url(#onb-silver)"
      />
      <path
        d="M40 52l3 3 6-6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
      />
      <path
        d="M62 52h56"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
        opacity="0.85"
      />
      <circle
        cx="44"
        cy="82"
        r="9"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
        opacity="0.6"
      />
      <path
        d="M62 82h44"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
        opacity="0.5"
      />
      <circle
        cx="44"
        cy="112"
        r="9"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
        opacity="0.4"
      />
      <path
        d="M62 112h50"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
        opacity="0.35"
      />
      <circle cx="118" cy="78" r="1.6" fill="var(--ember-2)" opacity="0.9" />
      <circle cx="126" cy="86" r="1.2" fill="var(--ember-2)" opacity="0.7" />
    </Frame>
  );
}

/** Notes */
export function NotesIllo() {
  return (
    <Frame>
      <ellipse
        cx="80"
        cy="128"
        rx="44"
        ry="18.48"
        fill="url(#onb-ember)"
        opacity="0.9"
      />
      <path
        d="M48 32h46l18 18v78H48z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="url(#onb-silver)"
      />
      <path
        d="M94 32v18h18"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
        opacity="0.7"
      />
      <path
        d="M60 66h40"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
        stroke="currentColor"
      />
      <path
        d="M60 82h32M60 96h38M60 110h24"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
        opacity="0.5"
      />
      <circle cx="104" cy="110" r="2" fill="var(--ember-2)" opacity="0.9" />
      <circle cx="110" cy="118" r="1.3" fill="var(--ember-2)" opacity="0.7" />
    </Frame>
  );
}

/** Goals */
export function GoalsIllo() {
  return (
    <Frame>
      <ellipse
        cx="80"
        cy="130"
        rx="50"
        ry="21"
        fill="url(#onb-ember)"
        opacity="0.9"
      />
      <path
        d="M28 128L64 68l16 22 12-14 40 52"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="url(#onb-silver)"
      />
      <path
        d="M92 76V44"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
      />
      <path
        d="M92 44h22l-6 8 6 8H92"
        strokeWidth="2"
        strokeLinejoin="round"
        stroke="currentColor"
        fill="var(--ember)"
        fillOpacity="0.25"
      />
      <path
        d="M44 128h72"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
        opacity="0.4"
      />
      <circle cx="60" cy="112" r="1.5" fill="var(--ember-2)" opacity="0.7" />
      <circle cx="70" cy="100" r="1.2" fill="var(--ember-2)" opacity="0.6" />
    </Frame>
  );
}

/** Family */
export function FamilyIllo() {
  return (
    <Frame>
      <ellipse
        cx="80"
        cy="122"
        rx="58"
        ry="24.36"
        fill="url(#onb-ember)"
        opacity="0.9"
      />
      <circle
        cx="52"
        cy="58"
        r="11"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="url(#onb-silver)"
      />
      <circle
        cx="108"
        cy="58"
        r="11"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="url(#onb-silver)"
      />
      <circle
        cx="80"
        cy="76"
        r="8"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
      />
      <path
        d="M30 108a22 22 0 0 1 44 0"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
        opacity="0.85"
      />
      <path
        d="M86 108a22 22 0 0 1 44 0"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
        opacity="0.85"
      />
      <path
        d="M64 112a16 16 0 0 1 32 0"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
      />
      <rect
        x="58"
        y="124"
        width="44"
        height="8"
        rx="4"
        fill="var(--ember)"
        fillOpacity="0.55"
        stroke="var(--ember-2)"
        strokeOpacity="0.6"
        strokeWidth="1"
      />
      <circle cx="70" cy="128" r="1.8" fill="var(--ember-2)" opacity="1" />
      <circle cx="82" cy="127" r="1.5" fill="var(--ember-2)" opacity="0.95" />
      <circle cx="92" cy="129" r="1.3" fill="var(--ember-2)" opacity="0.9" />
      <circle cx="77" cy="116" r="1.1" fill="var(--ember-2)" opacity="0.7" />
      <circle cx="88" cy="112" r="0.9" fill="var(--ember-2)" opacity="0.55" />
    </Frame>
  );
}

/** Data */
export function DataIllo() {
  return (
    <Frame>
      <ellipse
        cx="80"
        cy="126"
        rx="40"
        ry="16.8"
        fill="url(#onb-ember)"
        opacity="0.9"
      />
      <path
        d="M80 30l36 12v34c0 24-16 40-36 50-20-10-36-26-36-50V42z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="url(#onb-silver)"
      />
      <rect
        x="68"
        y="74"
        width="24"
        height="20"
        rx="4"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
      />
      <path
        d="M73 74v-7a7 7 0 0 1 14 0v7"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
      />
      <circle cx="80" cy="84" r="2" fill="var(--ember-2)" opacity="0.9" />
    </Frame>
  );
}

/** Simple */
export function SimpleIllo() {
  return (
    <Frame>
      <ellipse
        cx="80"
        cy="120"
        rx="44"
        ry="18.48"
        fill="url(#onb-ember)"
        opacity="0.9"
      />
      <path
        d="M80 44c2 18 10 26 28 28-18 2-26 10-28 28-2-18-10-26-28-28 18-2 26-10 28-28z"
        strokeWidth="2"
        strokeLinejoin="round"
        stroke="url(#onb-silver)"
        fill="var(--ember)"
        fillOpacity="0.12"
      />
      <path
        d="M114 44c1 6 3 8 9 9-6 1-8 3-9 9-1-6-3-8-9-9 6-1 8-3 9-9z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        stroke="currentColor"
        opacity="0.7"
      />
      <circle cx="48" cy="104" r="1.6" fill="var(--ember-2)" opacity="0.8" />
      <circle cx="112" cy="100" r="1.3" fill="var(--ember-2)" opacity="0.7" />
    </Frame>
  );
}
