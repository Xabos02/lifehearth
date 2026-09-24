// Жизненный цикл семейных групп: создать / войти по приглашению / код
// приглашения / выйти. Поддерживает несколько групп — create/join ДОБАВЛЯЮТ
// группу, не перезатирая существующие.

import {
  generateKey,
  exportKeyRaw,
  importKeyRaw,
  newAccountId,
  randomToken,
  decodeFamilyPairing,
  generateInviteWord,
  openInvite,
  peekInvite,
  sealInvite,
} from '../crypto';
import { saveFamilyConfig, getFamilyConfig, listFamilyConfigs, clearFamily } from './familyState';
import { upsertSelfMember } from './familyRepo';
import { connectFamily, disconnectFamily, sendSystemMessage, unregisterFamilyPush } from './familyChat';
import { ensureBoxKeys, registerMember } from './familyKeys';
import { WORKER_URL } from '../workerUrl';
import { t } from '../i18n';

/** Создать новую группу на этом устройстве (ты — первый участник). Возвращает
 *  familyId созданной группы (чтобы UI сразу её выбрал). */
export async function createFamily(familyName: string, displayName: string): Promise<string> {
  const key = await generateKey();
  const familyId = newAccountId();
  const selfMemberId = newAccountId();
  await saveFamilyConfig({
    id: familyId,
    familyId,
    familyToken: randomToken(),
    familyKey: key,
    familyName: familyName.trim() || t('Семья'),
    selfMemberId,
    lastSeq: 0,
    lastReadSeq: 0,
    enabled: true,
    joinedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), // конфиг уедет на другие устройства аккаунта
    keyEpoch: 0,
    keyRing: { '0': key },
    // Создатель — владелец. Секрет в приглашение не попадает: он и есть
    // единственное отличие того, кто может исключать, от всех остальных.
    ownerSecret: randomToken(),
    ownerMemberId: selfMemberId,
  });
  await ensureBoxKeys((await getFamilyConfig(familyId))!);
  await upsertSelfMember(familyId, displayName);
  void registerMember(familyId);
  connectFamily(familyId);
  return familyId;
}

/** Войти в существующую группу по коду приглашения (QR/строка). Если уже
 *  состоишь в этой группе — просто возвращаем её id (без дубля). */
export async function joinFamily(
  code: string,
  displayName: string,
  word?: string,
): Promise<string> {
  // Новый формат (v:3) требует кодового слова; старые коды (v:2) принимаем
  // как есть — люди могли сохранить приглашение до обновления, и ломать им
  // вход ради чистоты формата нельзя.
  const p = word !== undefined ? await openInvite(code, word) : decodeFamilyPairing(code);
  const existing = await getFamilyConfig(p.familyId);
  if (existing) {
    connectFamily(p.familyId);
    return p.familyId;
  }
  const key = await importKeyRaw(p.key);
  // Связка ключей из приглашения: все эпохи, что были в группе до нас. Без них
  // прошлая переписка осталась бы нечитаемой — сервер её отдаёт, а расшифровать
  // нечем. Старые приглашения (без keys) — группа одной эпохи.
  const keyRing: Record<string, CryptoKey> = {};
  // Старый формат (v:2) полей связки не знает вовсе — у него всегда одна эпоха.
  const past = 'keys' in p ? (p.keys ?? {}) : {};
  for (const [e, raw] of Object.entries(past)) keyRing[e] = await importKeyRaw(raw);
  const epoch = ('epoch' in p ? p.epoch : 0) ?? 0;
  keyRing[String(epoch)] = key;
  await saveFamilyConfig({
    id: p.familyId,
    familyId: p.familyId,
    familyToken: p.familyToken,
    familyKey: key,
    familyName: p.familyName,
    selfMemberId: newAccountId(),
    lastSeq: 0,
    lastReadSeq: 0,
    enabled: true,
    joinedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), // конфиг уедет на другие устройства аккаунта
    keyEpoch: epoch,
    keyRing,
  });
  await ensureBoxKeys((await getFamilyConfig(p.familyId))!);
  await upsertSelfMember(p.familyId, displayName);
  // Регистрируемся до подключения: сервер должен знать наш публичный ключ
  // раньше, чем в группе кого-то исключат, иначе новый ключ передать нечем.
  await registerMember(p.familyId);
  connectFamily(p.familyId);
  // Системное сообщение всем участникам: кто-то присоединился (уйдёт из outbox
  // при подключении; офлайн-участникам прилетит пушем как обычное сообщение).
  // Без name при пустом имени: заглушка «Участник» локализуется у зрителя,
  // а не запекается языком присоединившегося.
  void sendSystemMessage(
    p.familyId,
    displayName.trim() ? { kind: 'join', name: displayName.trim() } : { kind: 'join' },
  );
  return p.familyId;
}

/** Приглашение в группу: код плюс кодовое слово к нему.
 *
 *  Слово генерируется каждый раз новое и в приложении нигде не сохраняется:
 *  оно живёт ровно столько, сколько открыт экран приглашения. Приглашающий
 *  называет его отдельно от кода — голосом, при встрече, другим каналом.
 *  Смысл в том, что перехваченный код без слова бесполезен, а раньше он
 *  содержал ключ от всей переписки открытым текстом. */
export async function createFamilyInvite(
  familyId: string,
): Promise<{ code: string; word: string; expiresAt: string } | null> {
  const c = await getFamilyConfig(familyId);
  if (!c) return null;
  const word = generateInviteWord();
  // Все эпохи ключа, а не только текущая: иначе приглашённый увидит переписку
  // до последнего исключения как набор нечитаемых записей.
  const keys: Record<string, string> = {};
  for (const [e, k] of Object.entries(c.keyRing ?? {})) keys[e] = await exportKeyRaw(k);
  const code = await sealInvite(
    {
      familyId: c.familyId,
      familyToken: c.familyToken,
      key: await exportKeyRaw(c.familyKey),
      familyName: c.familyName,
      keys,
      epoch: c.keyEpoch ?? 0,
    },
    word,
  );
  return { code, word, expiresAt: peekInvite(code).expiresAt };
}

/** Выйти из группы на этом устройстве (её локальные данные стираются).
 *
 *  Порядок важен: сначала отписка от уведомлений — на неё нужен токен группы,
 *  который сотрёт clearFamily. Без отписки телефон продолжал бы звенеть
 *  «Входящий звонок» из группы, из которой человек уже вышел. */
export async function leaveFamily(familyId: string): Promise<void> {
  await unregisterFamilyPush(familyId).catch(() => {});
  disconnectFamily(familyId);
  await clearFamily(familyId);
  // Разбор последнего звонка тоже про эту группу — уносить его с собой
  // некуда и незачем.
  try {
    localStorage.removeItem('life-hub-call-diag');
  } catch {
    /* приватный режим */
  }
}

/** Удалить группу целиком. Доступно только создателю: у него есть секрет
 *  владельца, и только его сервер пустит. Группа исчезает у ВСЕХ участников —
 *  сервер стирает переписку, задачи и участников и рвёт живые соединения.
 *
 *  Порядок: сначала сервер (если он откажет — локально ничего не трогаем),
 *  затем та же локальная чистка, что и при выходе из группы. */
export async function deleteFamily(familyId: string): Promise<void> {
  const c = await getFamilyConfig(familyId);
  if (!c) return;
  const ownerSecret = c.ownerSecret;
  if (!ownerSecret) throw new Error(t('Удалить группу может только её создатель'));
  // Обрыв сети — исключение fetch, и его текст («Failed to fetch») экран
  // показал бы как есть: переводим в слова здесь, в одном месте.
  const res = await fetch(`${WORKER_URL}/family/delete?familyId=${familyId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.familyToken}`,
      'X-Family-Owner': ownerSecret,
      'Content-Type': 'application/json',
    },
  }).catch(() => null);
  if (!res) throw new Error(t('Нет связи с сервером. Проверьте интернет и попробуйте снова.'));
  if (!res.ok) {
    if (res.status === 403) throw new Error(t('Удалить группу может только её создатель'));
    throw new Error(t('Не удалось удалить группу. Проверьте связь и попробуйте ещё раз'));
  }
  await unregisterFamilyPush(familyId).catch(() => {});
  disconnectFamily(familyId);
  await clearFamily(familyId);
}

/** familyId группы, которую показать по умолчанию (первая по joinedAt). */
export async function firstFamilyId(): Promise<string | null> {
  const all = await listFamilyConfigs();
  return all[0]?.familyId ?? null;
}
