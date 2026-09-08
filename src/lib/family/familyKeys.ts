// Ключи группы и исключение участников.
//
// Задача, ради которой всё это существует: убрать человека из семейной группы
// так, чтобы он перестал читать переписку. Одной кнопки на сервере мало —
// сервер нам не доверенное лицо, и «он больше не подключится» ничего не значит,
// если ключ от шифротекста у него на руках. Значит после исключения группа
// должна перейти на НОВЫЙ ключ, а исключённый не должен его получить.
//
// Раздать новый ключ общим каналом нельзя: исключённый ещё в группе и прочитает
// рассылку старым ключом. Поэтому каждому оставшемуся кладётся личный конверт,
// зашифрованный на его публичный ключ (ECDH). Исключённому конверт не кладётся
// вовсе, а если старый лежал — сервер его удаляет.
//
// Три вещи, которые эта схема НЕ даёт, и о них честно в docs/family-chat-security.md:
//  — прошлую переписку исключённый читает: у него остался старый ключ и, если
//    он сохранил копию сообщений, они при нём. Отобрать скачанное невозможно;
//  — участник без публичного ключа (не обновил приложение) нового ключа не
//    получит и выпадет из группы вместе с исключённым — поэтому перед
//    исключением о таких предупреждаем;
//  — владельца исключить нельзя, и если он потерял устройство вместе с
//    секретом — исключать больше некому.

import { db } from '../../db/db';
import type { FamilyConfig, FamilyMember } from '../../db/types';
import {
  decryptJSON,
  encryptJSON,
  exportBoxPrivate,
  exportBoxPublic,
  exportKeyRaw,
  generateBoxKeyPair,
  generateKey,
  importBoxPrivate,
  importBoxPublic,
  importKeyRaw,
  openFrom,
  packEpoch,
  randomToken,
  sealFor,
  sha256hex,
  unpackEpoch,
} from '../crypto';
import { getFamilyConfig, patchFamilyConfig } from './familyState';
import { t } from '../i18n';

export { WORKER_URL } from '../workerUrl';
import { WORKER_URL } from '../workerUrl';

/** Содержимое личного конверта: новый ключ группы и новый токен доступа. */
interface SealedKeyPayload {
  epoch: number;
  keyRaw: string;
  familyToken: string;
  /** ВСЯ связка эпох, а не только текущая: { '0': raw, '1': raw, ... }.
   *
   *  Конверт на сервере один на участника — ingest перезаписывает его по паре
   *  (channel, item_id). Значит второе исключение затирает конверт первого, и
   *  тот, кто был офлайн во время обоих, забирает только последний. С одним
   *  ключом внутри он получал связку без пропущенной эпохи, и сообщения,
   *  написанные между двумя исключениями, у него не расшифровывались уже
   *  никогда — decFamily бросал «нет ключа эпохи N», а applyBatch глотал это
   *  молча.
   *
   *  Ровно так же устроено приглашение (InviteSecrets.keys) — там связка
   *  нужна по той же причине: без неё прошлая переписка нечитаема.
   *
   *  Поле необязательное: конверт, положенный прежней версией, разбирается
   *  по-старому. */
  keys?: Record<string, string>;
}

// === Эпохи: шифруем текущей, читаем любой известной ===

function epochOf(c: FamilyConfig): number {
  return c.keyEpoch ?? 0;
}

function keyForEpoch(c: FamilyConfig, epoch: number): CryptoKey | undefined {
  if (epoch === epochOf(c)) return c.familyKey;
  return c.keyRing?.[String(epoch)];
}

/** Зашифровать текущей эпохой и пометить её в шифротексте. */
export async function encFamily(c: FamilyConfig, obj: unknown): Promise<string> {
  return packEpoch(epochOf(c), await encryptJSON(c.familyKey, obj));
}

/** Расшифровать тем ключом, которым это было зашифровано. Ключа нет — бросаем:
 *  вызывающий уже умеет молча пропускать нечитаемое. */
export async function decFamily<T>(c: FamilyConfig, raw: string): Promise<T> {
  const { epoch, payload } = unpackEpoch(raw);
  const key = keyForEpoch(c, epoch);
  if (!key) throw new Error(`нет ключа эпохи ${epoch}`);
  return decryptJSON<T>(key, payload);
}

// === Личная пара участника ===

/** Завести пару для адресных конвертов, если её ещё нет. Возвращает конфиг с
 *  ключами — вызывающему они нужны сразу. */
export async function ensureBoxKeys(c: FamilyConfig): Promise<FamilyConfig> {
  if (c.boxPub && c.boxPriv) return c;
  const pair = await generateBoxKeyPair();
  const boxPub = await exportBoxPublic(pair.publicKey);
  const boxPriv = await exportBoxPrivate(pair.privateKey);
  await patchFamilyConfig(c.familyId, { boxPub, boxPriv });
  return { ...c, boxPub, boxPriv };
}

/** Зарегистрировать участника на сервере: публичный ключ и — для создателя
 *  группы — заявка на владение. Возвращает memberId владельца.
 *
 *  Вызывается при каждом подключении, не только при входе: у тех, кто вошёл в
 *  группу до появления этого механизма, ключа на сервере нет, а без него их
 *  нельзя ни оставить в группе при смене ключа, ни защитить от чужого. */
export async function registerMember(familyId: string): Promise<string | null> {
  let c = await getFamilyConfig(familyId);
  if (!c) return null;
  c = await ensureBoxKeys(c);
  try {
    const res = await fetch(`${WORKER_URL}/family/register?familyId=${c.familyId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.familyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        memberId: c.selfMemberId,
        boxPub: c.boxPub,
        // Хеш, не сам секрет: сервер должен уметь проверить владельца, но не
        // должен уметь им притвориться.
        ...(c.ownerSecret ? { ownerSecretHash: await sha256hex(c.ownerSecret) } : {}),
      }),
    });
    if (!res.ok) return null;
    const { owner } = (await res.json()) as { owner: string | null };
    // Владелец закрепляется единожды: подмена сервером после первой регистрации
    // не пройдёт — иначе он назначил бы владельцем сообщника.
    if (owner && !c.ownerMemberId) await patchFamilyConfig(familyId, { ownerMemberId: owner });
    return owner;
  } catch {
    return null; // нет сети — попробуем на следующем подключении
  }
}

/** Есть ли у группы владелец на сервере. null — не смогли спросить.
 *
 *  Нужно группам, созданным до появления владельцев: у их конфигов нет
 *  ownerSecret ни у кого, поэтому заявку на владение не шлёт никто, сервер
 *  так и остаётся без owner_member_id, и кнопка «Исключить» не появляется ни
 *  у кого и никогда. */
export async function familyHasOwner(familyId: string): Promise<boolean | null> {
  const c = await getFamilyConfig(familyId);
  if (!c) return null;
  try {
    const res = await fetch(`${WORKER_URL}/family/register?familyId=${familyId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.familyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: c.selfMemberId, boxPub: c.boxPub }),
    });
    if (!res.ok) return null;
    const { owner } = (await res.json()) as { owner: string | null };
    return Boolean(owner);
  } catch {
    return null;
  }
}

/** Забрать владение группой, у которой владельца нет.
 *
 *  Делается ЯВНЫМ действием человека, а не молча при подключении. Отличить
 *  создателя старой группы от того, кто вошёл по приглашению, в её конфиге
 *  нечем — такого поля тогда просто не существовало. Значит любой
 *  автоматический захват был бы гонкой: владельцем навсегда становился бы тот,
 *  чей телефон первым вышел в сеть. Для чужой семейной группы это плохая
 *  цена за удобство, поэтому решение принимает человек, а не порядок запуска.
 *
 *  Сервер держит TOFU: первая заявка выигрывает, вторая ничего не меняет.
 *  Возвращает true, если владение теперь наше. */
export async function claimOwnership(familyId: string): Promise<boolean> {
  let c = await getFamilyConfig(familyId);
  if (!c) return false;
  if (c.ownerSecret) return true;
  c = await ensureBoxKeys(c);
  const secret = randomToken();
  try {
    const res = await fetch(`${WORKER_URL}/family/register?familyId=${familyId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.familyToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        memberId: c.selfMemberId,
        boxPub: c.boxPub,
        ownerSecretHash: await sha256hex(secret),
      }),
    });
    if (!res.ok) return false;
    const { owner } = (await res.json()) as { owner: string | null };
    if (owner !== c.selfMemberId) return false; // нас опередили
    // Секрет храним ТОЛЬКО после подтверждения сервером: иначе у нас лежал бы
    // «ключ владельца», которого сервер не признаёт, и кнопка «Исключить»
    // появилась бы, чтобы отказать при нажатии.
    await patchFamilyConfig(familyId, { ownerSecret: secret, ownerMemberId: owner });
    return true;
  } catch {
    return false;
  }
}

/** Разослать свой публичный ключ остальным через канал 'member'. */
export async function publishBoxPub(familyId: string): Promise<void> {
  const c = await getFamilyConfig(familyId);
  if (!c?.boxPub) return;
  const mem = await db.familyMembers.get(c.selfMemberId);
  if (!mem || mem.boxPub === c.boxPub) return;
  await db.familyMembers.put({ ...mem, boxPub: c.boxPub, seq: 0 });
}

// === Приём нового ключа ===

/** Забрать свой конверт с сервера. Без авторизации: после смены ключа старый
 *  токен уже не подходит, а новый — как раз внутри конверта. */
async function fetchSealedKey(familyId: string, memberId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${WORKER_URL}/family/keys?familyId=${familyId}&member=${encodeURIComponent(memberId)}`,
    );
    if (!res.ok) return null;
    return ((await res.json()) as { sealed: string | null }).sealed;
  } catch {
    return null;
  }
}

/** Принять новый ключ группы из конверта. true — приняли, ключ сменился. */
export async function adoptSealedKey(familyId: string, sealed: string): Promise<boolean> {
  const c = await getFamilyConfig(familyId);
  if (!c?.boxPriv || !c.ownerMemberId) return false;
  // Конверт открывается ПУБЛИЧНЫМ ключом владельца — это и есть проверка
  // отправителя: такой же общий секрет не выведет никто, кроме него. Сервер,
  // подложивший свой конверт, получит здесь ошибку расшифровки.
  const owner = await db.familyMembers.get(c.ownerMemberId);
  if (!owner?.boxPub) return false;
  let inner: SealedKeyPayload;
  try {
    inner = await openFrom<SealedKeyPayload>(
      await importBoxPublic(owner.boxPub),
      await importBoxPrivate(c.boxPriv),
      sealed,
    );
  } catch {
    return false;
  }
  if (!inner?.keyRaw) return false; // мусор
  // Обычный случай — конверт новее нашей эпохи. Но принимаем и конверт РОВНО
  // нашей эпохи, если токен в нём другой: значит мы приняли ключ, а токен с
  // тех пор разошёлся с серверным, и без этой поблажки устройство осталось бы
  // запертым снаружи навсегда — сервер отвечает 401, а единственный конверт,
  // способный нас вернуть, отбрасывался бы как «старьё».
  const stale = inner.epoch === epochOf(c) && inner.familyToken !== c.familyToken;
  if (inner.epoch < epochOf(c) || (inner.epoch === epochOf(c) && !stale)) return false;
  const key = await importKeyRaw(inner.keyRaw);
  // Достраиваем связку всеми эпохами из конверта, а не только принятой: иначе
  // пропущенная смена ключа навсегда оставила бы дыру в читаемости переписки.
  const ring: Record<string, CryptoKey> = { ...(c.keyRing ?? {}) };
  for (const [e, raw] of Object.entries(inner.keys ?? {})) {
    if (!ring[e]) ring[e] = await importKeyRaw(raw);
  }
  ring[String(inner.epoch)] = key;
  await patchFamilyConfig(familyId, {
    familyKey: key,
    keyEpoch: inner.epoch,
    keyRing: ring,
    familyToken: inner.familyToken,
    // Своим устройствам новый ключ уедет аккаунтным синком — им конверт
    // забирать не придётся.
    updatedAt: new Date().toISOString(),
  });
  return true;
}

/** Последняя попытка войти, когда сервер отвечает 401: возможно, пока нас не
 *  было, группа сменила ключ. Забираем конверт и пробуем ещё раз. */
export async function recoverAccess(familyId: string): Promise<boolean> {
  const c = await getFamilyConfig(familyId);
  if (!c) return false;
  const sealed = await fetchSealedKey(familyId, c.selfMemberId);
  if (!sealed) return false;
  return adoptSealedKey(familyId, sealed);
}

// === Исключение участника (только владелец) ===

export interface RemovalPlan {
  /** Кого переведём на новый ключ. */
  keeping: FamilyMember[];
  /** У кого нет публичного ключа: новый ключ им передать нечем, и после
   *  исключения они тоже выпадут. Не обновили приложение. */
  stranded: FamilyMember[];
}

/** Что будет, если исключить этого участника. Показываем ДО подтверждения:
 *  «вместе с ним группу потеряют ещё двое» — это должно всплыть заранее, а не
 *  после. */
export async function planRemoval(familyId: string, memberId: string): Promise<RemovalPlan> {
  const c = await getFamilyConfig(familyId);
  const all = await db.familyMembers.where('familyId').equals(familyId).toArray();
  const rest = all.filter((m) => m.id !== memberId && !m.removedAt && !m.leftAt);
  return {
    keeping: rest.filter((m) => m.boxPub || m.id === c?.selfMemberId),
    stranded: rest.filter((m) => !m.boxPub && m.id !== c?.selfMemberId),
  };
}

/** Участник исключён и ключ сменён, но новый ключ дошёл не до всех.
 *
 *  Отдельный класс, а не общая ошибка: смысл здесь другой. Исключение
 *  СОСТОЯЛОСЬ и переигрывать его не надо — недоставленное чинится повтором, а
 *  сообщение «не удалось исключить» толкало бы человека жать кнопку ещё раз и
 *  крутить лишнюю эпоху ключа на каждый тап. */
export class KeyDeliveryError extends Error {
  readonly names: string[];
  constructor(names: string[]) {
    super(
      t('Участник исключён, но новый ключ пока не дошёл до: {names}. Повторите, когда они будут в сети.', {
        names: names.join(', '),
      }),
    );
    this.name = 'KeyDeliveryError';
    this.names = names;
  }
}

/** Разложить личные конверты с ТЕКУЩИМ ключом группы всем, кто в ней остался.
 *
 *  Отдельной функцией, потому что вызывается дважды: в конце исключения и
 *  повтором, когда часть конвертов не дошла. Повтор безопасен — конверт
 *  перезаписывается по (channel, itemId), эпоха не меняется, и принявший его
 *  раньше просто отбросит дубль.
 *
 *  Возвращает имена тех, до кого не дошло. Пустой список — все получили. */
export async function resendKeys(familyId: string): Promise<string[]> {
  const c = await getFamilyConfig(familyId);
  if (!c?.boxPriv) return [];
  const epoch = epochOf(c);
  const ring = { ...(c.keyRing ?? {}), [String(epoch)]: c.familyKey };
  const keys: Record<string, string> = {};
  for (const [e, k] of Object.entries(ring)) keys[e] = await exportKeyRaw(k);
  const payload: SealedKeyPayload = {
    epoch,
    keyRaw: keys[String(epoch)],
    familyToken: c.familyToken,
    keys,
  };
  const myPriv = await importBoxPrivate(c.boxPriv);
  const all = await db.familyMembers.where('familyId').equals(familyId).toArray();
  const targets = all.filter((m) => !m.removedAt && !m.leftAt && m.boxPub);
  // Себе конверт тоже: у другого моего устройства тот же memberId, и если
  // аккаунтный синк выключен, оно заберёт ключ отсюда.
  if (!targets.some((m) => m.id === c.selfMemberId) && c.boxPub) {
    targets.push({ id: c.selfMemberId, boxPub: c.boxPub, displayName: '' } as FamilyMember);
  }

  const failed: string[] = [];
  for (const m of targets) {
    try {
      const ciphertext = await sealFor(await importBoxPublic(m.boxPub!), myPriv, payload);
      const r = await fetch(`${WORKER_URL}/family/send?familyId=${familyId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.familyToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'key', itemId: m.id, ciphertext }),
      });
      if (!r.ok) failed.push(m.displayName || t('участник'));
    } catch {
      failed.push(m.displayName || t('участник'));
    }
  }
  return failed;
}

export class NotOwnerError extends Error {
  constructor() {
    super(t('Исключать участников может только владелец группы'));
    this.name = 'NotOwnerError';
  }
}

/** Исключить участника и перевести группу на новый ключ.
 *
 *  ПОРЯДОК: сначала сервер (/family/remove), потом конверты остальным.
 *
 *  Раньше было наоборот — «конверты кладём ещё старым токеном, он пока
 *  действует». Рассуждение было ошибочным: после смены токена конверты
 *  прекрасно кладутся НОВЫМ, сервер как раз его и ждёт (checkToken сверяет с
 *  token_hash, который /remove только что переписал).
 *
 *  А цена ошибки была высокой. Конверты сервер тут же рассылает по сокетам, и
 *  каждый, кто онлайн, молча переходил на новый ключ и токен — ДО того, как о
 *  новом токене узнавал сам сервер. Не пройди следом /family/remove (обрыв
 *  сети, старый воркер в окно деплоя, отказ CORS) — и группа рвалась
 *  необратимо: владелец и сервер на старом токене, все остальные на новом,
 *  которого сервер не знает. Дальше вечный реконнект раз в три секунды со
 *  статусом «оффлайн» и без единого слова человеку; выход — только заново по
 *  приглашению, с потерей локальной переписки.
 *
 *  Теперь худшее, что бывает: сервер ключ сменил, а конверты не разошлись.
 *  Это состояние ЧИНИТСЯ повтором — конверты можно доложить когда угодно, а
 *  участники сами подхватят их из /family/keys, который отвечает без
 *  авторизации именно ради этого случая. */
export async function removeMember(familyId: string, memberId: string): Promise<RemovalPlan> {
  let c = await getFamilyConfig(familyId);
  if (!c) throw new Error(t('Группа не найдена'));
  const ownerSecret = c.ownerSecret;
  if (!ownerSecret) throw new NotOwnerError();
  c = await ensureBoxKeys(c);
  const plan = await planRemoval(familyId, memberId);

  const epoch = epochOf(c) + 1;
  const key = await generateKey();
  const familyToken = randomToken();
  // ШАГ 1. Сервер. Пока ничего не изменилось ни у кого: не пройдёт — просто
  // выходим, группа осталась ровно в том состоянии, в каком была.
  const res = await fetch(`${WORKER_URL}/family/remove?familyId=${familyId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.familyToken}`,
      'X-Family-Owner': ownerSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ memberId, newTokenHash: await sha256hex(familyToken) }),
  });
  if (!res.ok) throw new Error(`сервер отказал в исключении (${res.status})`);

  // ШАГ 2. Себя переводим на новый ключ СРАЗУ. Иначе обрыв на следующем шаге
  // оставил бы владельца со старым токеном, который сервер уже не принимает,
  // — то есть запертым из собственной группы.
  await patchFamilyConfig(familyId, {
    familyKey: key,
    keyEpoch: epoch,
    keyRing: { ...(c.keyRing ?? {}), [String(epoch)]: key },
    familyToken,
    updatedAt: new Date().toISOString(),
  });

  // ШАГ 3. Пометку об исключении ставим ДО раздачи: resendKeys раскладывает
  // конверты по живым участникам, и без этой пометки исключённый попал бы в
  // их число — то есть получил бы новый ключ, ради отзыва которого всё и
  // затевалось.
  const mem = await db.familyMembers.get(memberId);
  if (mem) await db.familyMembers.put({ ...mem, removedAt: new Date().toISOString(), seq: 0 });

  // ШАГ 4. Конверты остальным — уже НОВЫМ токеном, сервер ждёт именно его.
  // Первая неудача не обрывает раздачу: каждый конверт независим, и доставить
  // трём из четырёх лучше, чем никому. Кому не досталось — называем по имени,
  // чтобы человек знал, кого ждать, и мог повторить.
  const failed = await resendKeys(familyId);
  if (failed.length) throw new KeyDeliveryError(failed);
  return plan;
}
