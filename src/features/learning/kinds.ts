import type { LucideIcon } from 'lucide-react';
import { BookOpen, FileText, FlaskConical, Languages, Video } from 'lucide-react';
import { GLearning as GraduationCap } from '../../components/ui/glyphs';
import type { LearningKind } from '../../db/types';

/** Вид материала: значок и подпись — общие для списка и экрана материала. */
export const KIND_ICONS: Record<LearningKind, LucideIcon> = {
  book: BookOpen,
  course: GraduationCap,
  article: FileText,
  video: Video,
  research: FlaskConical,
  language: Languages,
};

export const KIND_LABEL: Record<LearningKind, string> = {
  book: 'Книга',
  course: 'Курс',
  article: 'Статья',
  video: 'Видео',
  research: 'Исследование',
  language: 'Язык',
};
