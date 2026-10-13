import { GFamily } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { isLightColor } from '../../lib/colors';
import type { FamilyMember } from '../../db/types';

/** Круг участника: его цвет и первая буква — тот же цвет, что у имени над его
 *  сообщениями. Глиф белый или тёмный по isLightColor (PROTOCOL §1.8). Белый
 *  круг на белой карточке светлой темы без границы пропадает (WCAG 1.4.11):
 *  граница нужна 3:1. --lh-border-strong давал 1.4, вторичный текст — 5.5. */
export function MemberAvatar({ member, className = 'size-11 text-lg' }: { member: FamilyMember; className?: string }) {
  const white = /^#?f{3}(f{3})?$/i.test(member.color);
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold ${
        isLightColor(member.color) ? 'text-on-light' : 'text-white'
      } ${white ? 'ring-1 ring-lh-text-secondary' : ''} ${className}`}
      style={{ background: member.color }}
    >
      {member.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Круг общего чата: знак семьи золотом на золотой подложке. Глиф — ступень
 *  ICON по стороне круга (icons.ts): 44 → header, 68 → display. */
export function GroupAvatar({ className = 'size-11', glyph = ICON.header }: { className?: string; glyph?: number }) {
  return (
    <span aria-hidden className={`flex shrink-0 items-center justify-center rounded-full bg-lh-accent-dim text-lh-accent ${className}`}>
      <GFamily size={glyph} />
    </span>
  );
}
