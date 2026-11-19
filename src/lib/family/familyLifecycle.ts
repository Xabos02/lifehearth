// Жизненный цикл семейных групп: создать / войти по приглашению / код
// приглашения / выйти. Поддерживает несколько групп — create/join ДОБАВЛЯЮТ
// группу, не перезатирая существующие.

import {
  generateKey,
  exportKeyRaw,
  importKeyRaw,
  newAccountId,
  randomToken,
  generateInviteWord,
  openInvite,
  peekInvite,
  sealInvite,
} from '../crypto';
import { saveFamilyConfig, getFamilyConfig, listFamilyConfigs, clearFamily } from './familyState';
import { upsertSelfMember } from './familyRepo';
import { connectDeadline, connectFamily, disconnectFamily, sendSystemMessage, unregisterFamilyPush } from './familyChat';
import { ensureBoxKeys, registerMember } from './familyKeys';
import { WORKER_URL } from '../workerUrl';
import { t } from '../i18n';

/** Создать новую группу на этом устройстве (ты — первый участник). Возвращает
 *  familyId созданной группы (чтобы UI сразу её выбрал). pair — личный чат на
 *  двоих: пометка едет в приглашение и держит чат в «Личных» у обоих. */
export async function createFamily(familyName: string, displayName: string, opts: { pair?: boolean } = {}): Promise<string> {
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
    ...(opts.pair ? { pair: true } : {}),
  });
  await ensureBoxKeys((await getFamilyConfig(familyId))!);
  await upsertSelfMember(familyId, displayName);
  // Подключение — после регистрации, а не вперегонки с ней: тикет, взятый
  // раньше, чем сервер узнал ключ создателя, не привязан к нему, а от
  // непривязанного соединения сервер не примет ни профиль, ни пометку
  // «исключён» — то есть владелец не смог бы исключать. Но экран регистрацию
  // не ждёт: без сети она занимает до 10 с (срок), а группа уже есть
  // локально — первый экран «Семьи» иначе сменялся бы списком без QR и лишь
  // потом прыгал в чат. Порядок «регистрация → подключение» держит цепочка;
  // само подключение тоже регистрирует перед тикетом (familyChat.connect).
  void registerMember(familyId, connectDeadline()).then(() => connectFamily(familyId));
  return familyId;
}

/** Войти в существующую группу по коду приглашения (QR/строка). Если уже
 *  состоишь в этой группе — просто возвращаем её id (без дубля).
 *
 *  Кроме устройства, которое сервер не признал участником (unverifiedAt): его
 *  пара ключей не та, что закреплена, и доказать прежнее «я» ему нечем. Такое
 *  входит заново, новым участником — переписка, курсоры и права владельца на
 *  устройстве остаются, меняется только личность и пара ключей. Прежний
 *  участник остаётся в списке у всех: убрать его может владелец. */
export async function joinFamily(
  code: string,
  displayName: string,
  word: string,
): Promise<string> {
  // Только v:3 — со словом и сроком в сутки. Старый код (v:2) несёт ключ
  // группы открытым текстом и не истекает: лежит в истории мессенджера, и
  // любой нашедший входил в семью. С 25.09 (задача 33) не принимается.
  const p = await openInvite(code, word);
  const existing = await getFamilyConfig(p.familyId);
  if (existing && !existing.unverifiedAt) {
    // Вошли раньше версией, не знавшей пометки «личный»: повторный вход по
    // тому же приглашению её дописывает, иначе чат так и остался бы «Группой».
    if (p.pair && !existing.pair) await saveFamilyConfig({ ...existing, pair: true, updatedAt: new Date().toISOString() });
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
    lastSeq: existing?.lastSeq ?? 0,
    lastReadSeq: existing?.lastReadSeq ?? 0,
    enabled: true,
    joinedAt: existing?.joinedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(), // конфиг уедет на другие устройства аккаунта
    keyEpoch: epoch,
    keyRing: { ...existing?.keyRing, ...keyRing },
    // Секрет владельца НЕ переносим. Новая личность — не владелец для
    // остальных: конверт с новым ключом они проверяют по публичному ключу
    // ПРЕЖНЕГО участника-владельца (ownerMemberId), а у этого устройства пара
    // уже другая. С секретом кнопка «Исключить» осталась бы, сервер исключение
    // принял бы — и после смены ключа конверт не открыл бы никто: группа
    // встала бы у всех. ownerMemberId оставляем: по нему проверяются конверты
    // настоящего владельца.
    ...(existing && { sortOrder: existing.sortOrder, ownerMemberId: existing.ownerMemberId }),
    ...(p.pair || existing?.pair ? { pair: true } : {}),
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
      pair: c.pair,
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
