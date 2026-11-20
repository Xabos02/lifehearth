import type { LucideIcon } from 'lucide-react';
import {
  GFaBook,
  GFaDisplay,
  GFaFlask,
  GFaLanguage,
  GFaNewspaperSolid,
  GFaVideo,
} from '../../components/ui/glyphs';
import type { LearningKind } from '../../db/types';

/** Вид материала: значок и подпись — общие для списка и экрана материала. */
export const KIND_ICONS: Record<LearningKind, LucideIcon> = {
  book: GFaBook,
  course: GFaDisplay,
  article: GFaNewspaperSolid,
  video: GFaVideo,
  research: GFaFlask,
  language: GFaLanguage,
};

export const KIND_LABEL: Record<LearningKind, string> = {
  book: 'Книга',
  course: 'Курс',
  article: 'Статья',
  video: 'Видео',
  research: 'Исследование',
  language: 'Язык',
};
