import { describe, expect, it } from 'vitest';
import { assembleFile, CHUNK_RAW_BYTES, fileKindLabel, formatFileSize, splitDataUrl } from './fileTransfer';

describe('splitDataUrl + assembleFile — круговой путь', () => {
  it('разрез и сборка без потерь возвращают исходную строку', () => {
    const original = 'data:text/plain;base64,' + 'A'.repeat(CHUNK_RAW_BYTES * 2 + 137); // некратно размеру чанка
    const parts = splitDataUrl(original);
    expect(parts.length).toBe(3); // 2 полных чанка + хвост
    const chunks = parts.map((data, idx) => ({ idx, data }));
    expect(assembleFile(chunks, parts.length)).toBe(original);
  });

  it('короткая строка (меньше одного чанка) даёт один кусок', () => {
    const original = 'data:text/plain;base64,YWJj';
    const parts = splitDataUrl(original);
    expect(parts).toEqual([original]);
    expect(assembleFile([{ idx: 0, data: parts[0] }], 1)).toBe(original);
  });

  it('неполный набор кусков → undefined (не всё доехало или ретеншн вытеснил хвост)', () => {
    // Без префикса dataURL: длина ровно кратна размеру чанка — чистые 3 куска.
    const original = 'B'.repeat(CHUNK_RAW_BYTES * 3);
    const parts = splitDataUrl(original);
    expect(parts.length).toBe(3);
    // Не хватает среднего куска.
    const partial = [
      { idx: 0, data: parts[0] },
      { idx: 2, data: parts[2] },
    ];
    expect(assembleFile(partial, parts.length)).toBeUndefined();
  });

  it('куски в перепутанном порядке всё равно собираются правильно', () => {
    const original = 'data:text/plain;base64,' + 'C'.repeat(CHUNK_RAW_BYTES * 2 + 50);
    const parts = splitDataUrl(original);
    const shuffled = [
      { idx: 2, data: parts[2] },
      { idx: 0, data: parts[0] },
      { idx: 1, data: parts[1] },
    ];
    expect(assembleFile(shuffled, parts.length)).toBe(original);
  });

  it('дубли по индексу: последний в массиве побеждает детерминированно', () => {
    const original = 'data:text/plain;base64,' + 'D'.repeat(10);
    const parts = splitDataUrl(original); // один короткий кусок, idx=0
    const withDupe = [
      { idx: 0, data: 'мусор из старой переотправки' },
      { idx: 0, data: parts[0] }, // этот — последний, он и должен победить
    ];
    expect(assembleFile(withDupe, 1)).toBe(parts[0]);
  });
});

describe('formatFileSize — границы', () => {
  it('1023 байта — ещё «Б», не «КБ»', () => {
    expect(formatFileSize(1023)).toBe('1023 Б');
  });

  it('ровно 1 МБ — целое число, без дробной части', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1 МБ');
  });

  it('7,5 МБ — дробная часть через запятую', () => {
    expect(formatFileSize(7.5 * 1024 * 1024)).toBe('7,5 МБ');
  });

  it('ровно 1 КБ — граница между Б и КБ', () => {
    expect(formatFileSize(1024)).toBe('1 КБ');
  });

  it('512 КБ — типичное значение из ТЗ', () => {
    expect(formatFileSize(512 * 1024)).toBe('512 КБ');
  });
});

describe('fileKindLabel — по mime и расширению', () => {
  it('PDF по mime', () => expect(fileKindLabel('application/pdf', 'отчёт')).toBe('Документ PDF'));
  it('PDF по расширению без mime', () => expect(fileKindLabel('', 'отчёт.PDF')).toBe('Документ PDF'));
  it('архив zip', () => expect(fileKindLabel('application/zip', 'a.zip')).toBe('Архив'));
  it('таблица xlsx', () =>
    expect(
      fileKindLabel('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'смета.xlsx'),
    ).toBe('Таблица'));
  it('текстовый файл', () => expect(fileKindLabel('text/plain', 'заметка.txt')).toBe('Текст'));
  it('неизвестный тип — общий «Файл»', () => expect(fileKindLabel('application/octet-stream', 'бинарник.bin')).toBe('Файл'));
});
