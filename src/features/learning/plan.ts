import { db } from '../../db/db';
import { alive, update } from '../../db/repo';
import type { LearningItem, LearningPart } from '../../db/types';
import { todayKey } from '../../lib/dates';

/** Разобранная строка плана. */
interface Parsed {
  section: string;
  title: string;
  estimate: number;
}

/** План вводится текстом, а не по одной части через форму.
 *
 *  Список тем почти всегда уже есть — на странице курса, в оглавлении книги,
 *  в письме от школы. Вставить его целиком занимает секунду, а забивать
 *  шестьдесят дисциплин по одной не станет никто. */
export function parsePlan(text: string): Parsed[] {
  const out: Parsed[] = [];
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      section = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    // «Тема 1. Введение — 3» и «Тема 1. Введение – 3»: число после тире —
    // оценка трудоёмкости. Тире внутри названия не мешает: берётся последнее.
    const m = line.match(/^(.*?)\s+[—–-]\s*([\d.,]+)\s*$/);
    const title = (m ? m[1] : line).replace(/^[-•*]\s*/, '').trim();
    if (!title) continue;
    out.push({
      section,
      title,
      estimate: m ? Number(m[2].replace(',', '.')) || 0 : 0,
    });
  }
  return out;
}

/** Обратно в текст — чтобы существующий план можно было править, а не вводить
 *  заново. */
export function planToText(parts: LearningPart[]): string {
  const lines: string[] = [];
  let section = '';
  for (const p of parts) {
    if (p.section !== section) {
      section = p.section;
      if (section) lines.push(`${lines.length ? '\n' : ''}# ${section}`);
    }
    lines.push(p.estimate > 0 ? `${p.title} — ${p.estimate}` : p.title);
  }
  return lines.join('\n');
}


/** Отметка части плана — вынесена, чтобы список не тянул за собой репозиторий. */
export async function togglePart(part: LearningPart, item: LearningItem): Promise<void> {
  const doneAt = part.doneAt ? null : todayKey();
  await update(db.learningParts, part.id, { doneAt });
  // Прогресс материала — сумма закрытых частей. Пересчитываем целиком, а не
  // прибавляем: так отметка и снятие всегда сходятся с планом.
  const parts = alive(await db.learningParts.where('itemId').equals(item.id).toArray());
  const current = parts
    .map((p) => (p.id === part.id ? { ...p, doneAt } : p))
    .filter((p) => p.doneAt)
    .reduce((sum, p) => sum + p.estimate, 0);
  await update(db.learningItems, item.id, {
    progressCurrent: Math.min(item.progressTarget, current),
  });
}
