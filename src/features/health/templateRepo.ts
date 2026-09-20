import { db } from '../../db/db';
import { create, remove, update } from '../../db/repo';
import type { WorkoutTemplate, WorkoutTemplateItem } from '../../db/types';

export type TemplateDraft = Omit<WorkoutTemplate, keyof import('../../db/types').BaseEntity>;

export async function addTemplate(name: string, items: WorkoutTemplateItem[]): Promise<WorkoutTemplate> {
  return create(db.workoutTemplates, { name, items });
}

export async function updateTemplate(id: string, changes: Partial<TemplateDraft>): Promise<void> {
  await update(db.workoutTemplates, id, changes);
}

export async function removeTemplate(id: string): Promise<void> {
  await remove(db.workoutTemplates, id);
}
