import { describe, expect, it } from 'vitest';
import { hexColor, msgPayload, msgRowFromWire } from './familyChat';
import type { FamilyMessage } from '../../db/types';

// Контракт двух концов провода сообщений: msgPayload (отправка) и
// msgRowFromWire (приём). Шифрование здесь ни при чём — оно прозрачно для
// формы payload, поэтому «провод» имитируется честной JSON-сериализацией.

const wire = (p: object) => JSON.parse(JSON.stringify(p)) as Record<string, unknown>;

const meta = { itemId: 'c1', seq: 7, senderMemberId: 'm1', createdAt: '2026-08-14T10:00:00.000Z' };

function row(over: Partial<FamilyMessage>): FamilyMessage {
  return {
    clientMsgId: 'c1',
    familyId: 'f1',
    seq: null,
    senderMemberId: 'm1',
    createdAt: '2026-08-14T10:00:00.000Z',
    text: '',
    status: 'pending',
    deletedAt: null,
    ...over,
  };
}

describe('провод сообщений чата: payload ↔ строка', () => {
  it('типизированное системное событие переживает провод вместе с text', () => {
    const sent = row({ text: 'Вася присоединился', system: true, sys: { kind: 'join', name: 'Вася' } });
    const got = msgRowFromWire('f1', meta, wire(msgPayload(sent)), null);
    expect(got.sys).toEqual({ kind: 'join', name: 'Вася' });
    expect(got.text).toBe('Вася присоединился'); // fallback старых клиентов
    expect(got.system).toBe(true);
    expect(got.seq).toBe(7);
    expect(got.status).toBe('acked');
  });

  it('payload старого клиента (без sys) даёт строку с fallback-текстом', () => {
    const legacy = wire(msgPayload(row({ text: 'Мама присоединилась', system: true })));
    delete legacy.sys; // старый клиент этого поля не шлёт вовсе
    const got = msgRowFromWire('f1', meta, legacy, null);
    expect(got.sys).toBeNull();
    expect(got.text).toBe('Мама присоединилась');
  });

  it('картинка и голос — только встроенные data:, внешний адрес не принимается', () => {
    // Иначе телефон получателя сам запросил бы чужой URL при показе чата.
    const p = { ...wire(msgPayload(row({ text: '' }))), image: 'https://evil.example/px', audio: 'https://evil.example/a' };
    const got = msgRowFromWire('f1', meta, p, null);
    expect(got.image).toBeNull();
    expect(got.audio).toBeNull();
    const ok = { ...p, image: 'data:image/jpeg;base64,AAA', audio: 'data:audio/mp4;base64,AAA' };
    const kept = msgRowFromWire('f1', meta, ok, null);
    expect(kept.image).toBe('data:image/jpeg;base64,AAA');
    expect(kept.audio).toBe('data:audio/mp4;base64,AAA');
  });

  it('цвет участника и задачи — только hex: url() в background загрузил бы чужой адрес', () => {
    expect(hexColor('#7c9aff')).toBe('#7c9aff');
    expect(hexColor('url(https://evil.example/px)')).toBeNull();
    expect(hexColor('#fff url(https://evil.example/px)')).toBeNull();
    expect(hexColor(null)).toBeNull();
  });

  it('незнакомое поле будущей версии отбрасывается белым списком', () => {
    const future = { ...wire(msgPayload(row({ text: 'hi' }))), futureField: { anything: 1 } };
    const got = msgRowFromWire('f1', meta, future, null);
    expect('futureField' in got).toBe(false);
  });

  it('fileData не едет в payload, но своё локальное значение сохраняется', () => {
    const manifest = row({
      file: { fileId: 'f', name: 'a.txt', mime: 'text/plain', size: 3, chunksTotal: 1 },
      fileData: 'data:text/plain;base64,AAA',
    });
    const p = wire(msgPayload(manifest));
    expect('fileData' in p).toBe(false);
    const got = msgRowFromWire('f1', meta, p, 'data:text/plain;base64,AAA');
    expect(got.fileData).toBe('data:text/plain;base64,AAA');
    expect(got.file?.fileId).toBe('f');
  });
});

describe('длинное голосовое едет частями и остаётся голосовым', () => {
  it('длительность переживает провод в манифесте файла', () => {
    // Запись на пару минут не помещается в один кадр сокета и раньше
    // навсегда застревала в очереди, пытаясь уехать при каждом
    // переподключении. Теперь она едет тем же путём, что файлы, — но
    // получатель должен увидеть плеер, а не карточку вложения, и решает
    // это длительность, приехавшая в манифесте.
    const manifest: FamilyMessage = {
      clientMsgId: 'v1',
      familyId: 'f1',
      seq: 10,
      senderMemberId: 'me',
      createdAt: '2026-08-21T10:00:00.000Z',
      text: '',
      file: { fileId: 'fid', name: 'Голосовое сообщение', mime: 'audio/mp4', size: 900_000, chunksTotal: 3 },
      audioDur: 95,
      status: 'pending',
      deletedAt: null,
    };

    const wire = msgPayload(manifest) as Record<string, unknown>;
    expect(wire.audioDur).toBe(95);

    const back = msgRowFromWire('f1', { itemId: 'v1', seq: 10, senderMemberId: 'me', createdAt: manifest.createdAt }, wire, 'data:audio/mp4;base64,AAA');
    expect(back.audioDur).toBe(95);
    expect(back.file?.chunksTotal).toBe(3);
    // Содержимое собрано локально — этого достаточно, чтобы показать плеер.
    expect(back.fileData).toBeTruthy();
  });
});
