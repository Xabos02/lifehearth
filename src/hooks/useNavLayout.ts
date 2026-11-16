import { useMemo } from 'react';
import { useSettings } from './useSettings';
import {
  sectionsFor,
  SECTION_BY_ID,
  MAX_BOTTOM,
  DEFAULT_BOTTOM,
  ANCHOR_ID,
  type Section,
} from '../lib/sections';
import { computeNavLayout } from '../lib/navLayout';

export interface ResolvedNavLayout {
  bottom: Section[]; // разделы нижней панели, «Главная» первой
  more: Section[]; // разделы списка на «Главной», по порядку
  hidden: string[]; // id спрятанных
}

/** Раскладка навигации из settings.navConfig, нормализованная и разрешённая в
 *  объекты разделов. Единый источник для TabBar, HomePage и превью в настройке. */
export function useNavLayout(): ResolvedNavLayout {
  const settings = useSettings();
  const navConfig = settings.navConfig;
  const gender = settings.gender;
  return useMemo(() => {
    // Реестр берётся с учётом пола: у мужского профиля раздела «Женские дни»
    // не существует ни в панели, ни в списке «Главной», ни среди спрятанных.
    const layout = computeNavLayout(sectionsFor(gender), navConfig, {
      maxBottom: MAX_BOTTOM,
      defaultBottom: DEFAULT_BOTTOM,
      anchorId: ANCHOR_ID,
    });
    const resolve = (ids: string[]) =>
      ids.map((id) => SECTION_BY_ID.get(id)).filter((s): s is Section => Boolean(s));
    return { bottom: resolve(layout.bottom), more: resolve(layout.more), hidden: layout.hidden };
  }, [navConfig, gender]);
}
