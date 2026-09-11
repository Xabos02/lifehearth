import { describe, expect, it } from 'vitest';
import type { TaskFile } from '../db/types';
import { groupTaskAttachments, planTaskFileChunks } from './taskFiles';

const ts = '2026-09-11T10:00:00.000Z';
const row = (p: Partial<TaskFile>): TaskFile => ({
  id: p.id ?? Math.random().toString(36).slice(2),
  createdAt: ts, updatedAt: ts, deletedAt: null,
  taskId: 't1', fileId: 'f1', idx: 0, total: 1, name: 'смета.pdf', mime: 'application/pdf', size: 3, data: '',
  ...p,
});

describe('файлы задач', () => {
  it('план чанков несёт метаданные в каждом куске и нумерует их', () => {
    const plan = planTaskFileChunks('t1', 'f1', { name: 'смета.pdf', mime: 'application/pdf', size: 3 }, 'data:application/pdf;base64,QUJD');
    expect(plan.length).toBeGreaterThan(0);
    expect(plan[0]).toMatchObject({ taskId: 't1', fileId: 'f1', idx: 0, total: plan.length, name: 'смета.pdf', mime: 'application/pdf', size: 3 });
  });

  it('собирает файл из чанков в любом порядке и терпит дубли', () => {
    const rows = [
      row({ fileId: 'f1', idx: 1, total: 2, data: 'Yz' }),
      row({ fileId: 'f1', idx: 0, total: 2, data: 'data:text/plain;base64,QW' }),
      row({ fileId: 'f1', idx: 0, total: 2, data: 'data:text/plain;base64,QW' }),
    ];
    const [a] = groupTaskAttachments(rows);
    expect(a.data).toBe('data:text/plain;base64,QWYz');
  });

  it('неполное вложение возвращается без содержимого — «ещё едет»', () => {
    const [a] = groupTaskAttachments([row({ fileId: 'f2', idx: 0, total: 3, data: 'x' })]);
    expect(a.data).toBeUndefined();
    expect(a.name).toBe('смета.pdf');
  });

  it('удалённые чанки не считаются', () => {
    expect(groupTaskAttachments([row({ deletedAt: ts })])).toEqual([]);
  });

  it('порядок вложений стабилен — по имени', () => {
    const list = groupTaskAttachments([
      row({ fileId: 'b', name: 'Яблоки.txt', data: 'data:text/plain;base64,QQ' }),
      row({ fileId: 'a', name: 'Арбуз.txt', data: 'data:text/plain;base64,QQ' }),
    ]);
    expect(list.map((x) => x.name)).toEqual(['Арбуз.txt', 'Яблоки.txt']);
  });
});
