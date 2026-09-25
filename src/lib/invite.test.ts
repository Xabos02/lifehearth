import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  InviteDamagedError,
  InviteExpiredError,
  InviteWordError,
  encodeFamilyPairing,
  formatInviteWord,
  generateInviteWord,
  normalizeInviteWord,
  openInvite,
  parsePastedInvite,
  peekInvite,
  sealInvite,
} from './crypto';

const DATA = {
  familyId: 'fam-1',
  familyToken: 'secret-token',
  key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  familyName: 'Наша семья',
};

describe('кодовое слово', () => {
  it('восемь символов из алфавита без похожих', () => {
    for (let i = 0; i < 50; i++) {
      const w = generateInviteWord();
      expect(w).toHaveLength(8);
      // Ни O, ни 0, ни I, ни 1 — их путают на слух и при наборе.
      expect(w).not.toMatch(/[OI0L1]/);
      expect(w).toMatch(/^[A-Z2-9]+$/);
    }
  });

  it('слова не повторяются', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateInviteWord()));
    expect(seen.size).toBe(200);
  });

  it('нормализация прощает регистр и пробелы, но не выдумывает символы', () => {
    expect(normalizeInviteWord('abcd efgh')).toBe('ABCDEFGH');
    expect(normalizeInviteWord('ab-cd-ef-gh')).toBe('ABCDEFGH');
    // Ввод с O остаётся с O: подменять нечем, в алфавите такого символа нет.
    expect(normalizeInviteWord('OBCDEFGH')).toBe('OBCDEFGH');
  });

  it('показывается группами по четыре', () => {
    expect(formatInviteWord('ABCDEFGH')).toBe('ABCD EFGH');
  });
});

describe('приглашение под кодовым словом', () => {
  it('открывается верным словом', async () => {
    const word = generateInviteWord();
    const code = await sealInvite(DATA, word);
    const opened = await openInvite(code, word);
    expect(opened).toEqual(DATA);
  });

  it('прощает регистр и пробелы при вводе', async () => {
    const word = 'ABCDEFGH';
    const code = await sealInvite(DATA, word);
    const opened = await openInvite(code, 'abcd efgh');
    expect(opened.familyToken).toBe(DATA.familyToken);
  });

  it('не открывается неверным словом', async () => {
    const code = await sealInvite(DATA, 'ABCDEFGH');
    await expect(openInvite(code, 'ABCDEFGJ')).rejects.toBeInstanceOf(InviteWordError);
  });

  it('ключ и токен не читаются из кода без слова', async () => {
    const code = await sealInvite(DATA, generateInviteWord());
    // Именно то, ради чего всё затевалось: перехваченный код не выдаёт ключ.
    const decoded = Buffer.from(code, 'base64url').toString('utf8');
    expect(decoded).not.toContain(DATA.key);
    expect(decoded).not.toContain(DATA.familyToken);
  });

  it('название группы видно до ввода слова', async () => {
    const code = await sealInvite(DATA, generateInviteWord());
    const peeked = peekInvite(code);
    expect(peeked.familyName).toBe('Наша семья');
    expect(peeked.familyId).toBe('fam-1');
  });

  it('просроченное приглашение не открывается', async () => {
    const word = generateInviteWord();
    const code = await sealInvite(DATA, word, -1); // истекло час назад
    await expect(openInvite(code, word)).rejects.toBeInstanceOf(InviteExpiredError);
  });

  it('испорченный код не проходит проверку формата', () => {
    expect(() => peekInvite('не-код')).toThrow();
  });
});

// Багрепорт 2026-08-12: «отправляю код, человек вводит — пишет "неверный код"».
// Код доезжает до поля ввода через мессенджер, и вставляют его вместе с тем,
// что вокруг: сопроводительным текстом, невидимыми символами разметки,
// переносами. Строгий парсер на этом падал, и верный код выглядел неверным.
describe('код, вставленный из мессенджера', () => {
  it('чистый код разбирается как раньше', async () => {
    const word = generateInviteWord();
    const code = await sealInvite(DATA, word);
    const parsed = parsePastedInvite(code);
    expect(parsed.kind).toBe('v3');
    expect(parsed.code).toBe(code);
    if (parsed.kind === 'v3') expect(parsed.peeked.familyName).toBe('Наша семья');
  });

  it('открывается код с сопроводительным текстом и эмодзи вокруг', async () => {
    const word = generateInviteWord();
    const code = await sealInvite(DATA, word);
    const pasted = `Привет! Вот код приглашения:\n${code}\nслово скажу голосом 🙂`;
    const parsed = parsePastedInvite(pasted);
    expect(parsed.kind).toBe('v3');
    const opened = await openInvite(parsed.code, word);
    expect(opened.familyToken).toBe(DATA.familyToken);
  });

  it('переживает невидимые символы разметки внутри кода', async () => {
    const word = generateInviteWord();
    const code = await sealInvite(DATA, word);
    // U+200E в начале и U+200B в середине — их дописывают чаты и клавиатуры.
    const cut = Math.floor(code.length / 2);
    const pasted = `\u200E${code.slice(0, cut)}\u200B${code.slice(cut)}`;
    const parsed = parsePastedInvite(pasted);
    expect(parsed.kind).toBe('v3');
    const opened = await openInvite(parsed.code, word);
    expect(opened.key).toBe(DATA.key);
  });

  it('собирает код, порванный переносами строк', async () => {
    const word = generateInviteWord();
    const code = await sealInvite(DATA, word);
    const third = Math.floor(code.length / 3);
    const pasted = `${code.slice(0, third)}\n${code.slice(third, third * 2)}\n${code.slice(third * 2)}`;
    const parsed = parsePastedInvite(pasted);
    expect(parsed.kind).toBe('v3');
    const opened = await openInvite(parsed.code, word);
    expect(opened.familyToken).toBe(DATA.familyToken);
  });

  it('длинное латинское слово рядом с кодом не мешает', async () => {
    const word = generateInviteWord();
    const code = await sealInvite(DATA, word);
    // Кусок ≥20 base64url-символов, который кодом не является: склейка «всё
    // подряд» дала бы мусор, поэтому целый код должен выигрывать у склейки.
    const parsed = parsePastedInvite(`congratulationsonjoiningthefamily ${code}`);
    expect(parsed.kind).toBe('v3');
    expect(parsed.code).toBe(code);
  });

  it('обрезанный код — внятная ошибка «повреждён», а не «неверный код»', async () => {
    const code = await sealInvite(DATA, generateInviteWord());
    // Скопировали не всё: хвост потерян при выделении вручную.
    const cut = code.slice(0, Math.floor(code.length * 0.8));
    expect(() => parsePastedInvite(cut)).toThrow(InviteDamagedError);
  });

  it('старый код (v:2) с текстом вокруг тоже распознаётся', () => {
    const code = encodeFamilyPairing({
      v: 2,
      familyId: 'fam-2',
      familyToken: 'tok',
      key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      familyName: 'Семья',
    });
    const parsed = parsePastedInvite(`держи: ${code}`);
    expect(parsed.kind).toBe('v2');
    expect(parsed.code).toBe(code);
  });

  it('случайный текст — не «повреждённый код», а просто не код', () => {
    expect(() => parsePastedInvite('просто длинное сообщение без кода внутри')).toThrow();
    expect(() => parsePastedInvite('просто длинное сообщение без кода внутри')).not.toThrow(
      InviteDamagedError,
    );
  });

  it('префиксы кодов детерминированы — на них держится детект «битого» кода', async () => {
    const v3 = await sealInvite(DATA, generateInviteWord());
    expect(v3.startsWith('eyJ2Ijoz')).toBe(true); // btoa('{"v":3')
    const v2 = encodeFamilyPairing({
      v: 2,
      familyId: 'f',
      familyToken: 't',
      key: 'k',
      familyName: 'n',
    });
    expect(v2.startsWith('eyJ2Ijoy')).toBe(true); // btoa('{"v":2')
  });
});

describe('старое приглашение v:2 не впускает', () => {
  it('ключ открытым текстом и без срока — вход отклонён, группа не заводится', async () => {
    // Такой код лежит в истории мессенджера годами: раньше любой нашедший
    // входил в семью и читал всю переписку (с 25.09 — отказ).
    const { joinFamily } = await import('./family/familyLifecycle');
    const { db } = await import('../db/db');
    const code = encodeFamilyPairing({ v: 2, familyId: 'fam-old', familyToken: 'tok', key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', familyName: 'Семья' });
    await expect(joinFamily(code, 'Влад', '')).rejects.toThrow();
    expect(await db.family.get('fam-old')).toBeUndefined();
  });
});
