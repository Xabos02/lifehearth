// Список чатов «Семьи» (канва design/family-chats, вариант Б): какие группы —
// общие чаты сверху, какие — личные, кто в личном собеседник, что показать
// превью.
//
// Личного сообщения в протоколе нет: у сообщения нет адресата, его читает
// вся группа. Поэтому личный чат — это отдельная группа на двоих со своим
// ключом, а не фильтр общей ленты. Вид вычисляется по составу: приглашение
// живёт сутки и не одноразовое, так что пара может стать тройкой — тогда она
// честно переедет наверх. Пометка pair у конфига (чат заведён как личный)
// только исключает его из правила «первая группа — общая» (firstGroupId).

import type { FamilyConfig, FamilyMember, FamilyMessage } from '../../db/types';
import { t } from '../../lib/i18n';

/** Адрес чата и его экранов. ?g= — та же ссылка, что у пуша и поиска:
 *  она открывает чат группы, а не список. */
export const chatPath = (familyId: string, view?: 'tasks' | 'members') =>
  `/more/family?g=${encodeURIComponent(familyId)}${view ? `&t=${view}` : ''}`;

/** Живой участник: не вышел и не исключён. Одно правило на список, шапку и
 *  карточку группы — раньше CallButton, ChatTab и MembersTab отсеивали
 *  по-разному. */
export const isAlive = (m: FamilyMember) => !m.leftAt && !m.removedAt;

/** Общий чат — любая группа, где больше двух живых участников, и «первая»
 *  (firstGroupId). Первая общая всегда: семья из двоих (вы и жена) — это
 *  семья с общими задачами, а не «личка». Остальные — личные. */
export const isGroupChat = (first: boolean, alive: number) => first || alive > 2;

/** «Первая» группа — первая по порядку из НЕ заведённых как личные. Личный
 *  чат по QR часто стоит у человека первым (других групп ещё нет), и если бы
 *  первым считался он, семья из двоих, созданная после, ушла бы в «Личные». */
export const firstGroupId = (configs: FamilyConfig[]) => configs.find((c) => !c.pair)?.familyId;

export function splitChats(
  configs: FamilyConfig[],
  members: FamilyMember[],
): { groups: FamilyConfig[]; pairs: FamilyConfig[] } {
  const groups: FamilyConfig[] = [];
  const pairs: FamilyConfig[] = [];
  const first = firstGroupId(configs);
  for (const c of configs) {
    const alive = members.filter((m) => m.familyId === c.familyId && isAlive(m)).length;
    (isGroupChat(c.familyId === first, alive) ? groups : pairs).push(c);
  }
  return { groups, pairs };
}

/** Собеседник в личном чате — единственный живой участник, кроме меня.
 *  Пока он не вошёл по приглашению, собеседника нет. */
export function partnerOf(cfg: FamilyConfig, members: FamilyMember[]): FamilyMember | undefined {
  const others = members.filter((m) => m.familyId === cfg.familyId && m.id !== cfg.selfMemberId && isAlive(m));
  return others.length === 1 ? others[0] : undefined;
}

/** Личный чат ждёт собеседника: его заводили, чтобы позвать одного человека
 *  (пометка pair или имя в pendingPartners — у пар до 1.79 пометки нет), я его
 *  завёл (секрет владельца есть только у создателя и его устройств) и, кроме
 *  меня, в нём никого ещё не было. Новая обычная группа, где пока я один, —
 *  не «ждём»: звали не одного человека. Вошедший по приглашению до прихода
 *  участников с сервера собеседника тоже не видит — но звать ему некого.
 *  Ушедший собеседник — не «ждём»: он был и вышел. */
export function awaitingPartner(cfg: FamilyConfig, members: FamilyMember[]): boolean {
  return (
    Boolean(cfg.pair || pendingPartners()[cfg.familyId]) &&
    Boolean(cfg.ownerSecret) &&
    !members.some((m) => m.familyId === cfg.familyId && m.id !== cfg.selfMemberId)
  );
}

/** Сниппет сообщения: цитата ответа в чате и превью строки в списке. */
export function snippetOf(m: FamilyMessage): string {
  if (m.text) return m.text.slice(0, 120);
  if (m.image) return t('Фото');
  if (m.audio) return t('Голосовое сообщение');
  if (m.file) return t('Файл');
  return t('Сообщение');
}

/** Время справа в строке: сегодня — часы, вчера — «Вчера», раньше — дата. */
export function previewWhen(iso: string, now: Date, locale: string, yesterday: string): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  // h23: время — 24 часа и в английском (PROTOCOL §7.7), не «06:42 PM».
  if (diff <= 0) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (diff === 1) return yesterday;
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

const PENDING_KEY = 'life-hub-family-pending-pairs';

/** Кого позвали в личный чат, пока он не вошёл: familyId → имя. Живёт только
 *  на этом телефоне. В название пары имя не кладём: название лежит открытым
 *  текстом в коде приглашения (crypto.ts, peekInvite читает его без слова). */
export function pendingPartners(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function rememberPending(familyId: string, name: string): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ ...pendingPartners(), [familyId]: name }));
  } catch {
    /* приватный режим: строка покажет название пары, а не имя */
  }
}
