import type { SectionId } from './sections';

// Чистая логика раскладки навигации — специально без импорта иконок/React, чтобы
// её можно было гонять юнит-тестами напрямую. Из реестра разделов и сохранённого
// конфига собирает три списка: нижняя панель, список «Главной», скрытые. Любой
// «битый» конфиг (несуществующие id, дубли, скрытый якорь, перебор лимита)
// нормализуется — UI никогда не должен получить некорректную раскладку.

/** Что хранится в settings (device-local). Строки, а не SectionId — на входе
 *  данные не доверенные, валидируются здесь. */
export interface NavConfig {
  bottom: string[]; // пользовательские разделы панели, по порядку (без якоря «Главной»)
  hidden: string[]; // спрятанные разделы
  more?: string[]; // порядок разделов внутри «Главной» (новые — в хвост по реестру)
}

export interface NavRegistryItem {
  id: SectionId;
  anchor?: boolean;
  nonHideable?: boolean;
  /** Новинка: пока человек раздел не расставлял, он ПЕРВЫЙ на «Главной», а не
   *  в хвосте за «Показать ещё» — иначе после анонса его не найти. Действует,
   *  только пока раздел не упомянут в конфиге. */
  featured?: boolean;
}

export interface NavLayout {
  bottom: SectionId[]; // id для панели, включая якорь последним
  more: SectionId[]; // id для списка «Главной», по порядку
  hidden: SectionId[]; // спрятанные id
}

export interface NavLayoutOpts {
  maxBottom: number; // сколько пользовательских разделов влезает слева от якоря
  defaultBottom: SectionId[]; // панель по умолчанию, если конфига нет
  anchorId: SectionId; // «Главная» — всегда последний слот панели
}

export function computeNavLayout(
  registry: NavRegistryItem[],
  config: Partial<NavConfig> | undefined,
  opts: NavLayoutOpts,
): NavLayout {
  const { maxBottom, defaultBottom, anchorId } = opts;
  const byId = new Map<string, NavRegistryItem>(registry.map((s) => [s.id, s]));
  const isNonHideable = (id: string) => Boolean(byId.get(id)?.nonHideable);
  const isAnchor = (id: string) => Boolean(byId.get(id)?.anchor);

  // Скрытые: существующие id, кроме нескрываемых и якоря. Дубли схлопывает Set.
  const hiddenSet = new Set<SectionId>();
  for (const id of config?.hidden ?? []) {
    if (!byId.has(id) || isNonHideable(id) || isAnchor(id)) continue;
    hiddenSet.add(id as SectionId);
  }

  // Упомянутые в конфиге хоть в одном из трёх списков — человек их уже
  // расставлял. Новинку (featured) поднимаем наверх, только пока её здесь нет.
  // Проверяем именно упоминание, а не отсутствие в more: спрятанная новинка
  // тоже «расставлена».
  const mentioned = new Set<string>([
    ...(config?.bottom ?? []),
    ...(config?.more ?? []),
    ...(config?.hidden ?? []),
  ]);

  // Панель: из конфига (или дефолта), существующие, не якорь, не скрытые,
  // уникальные, не больше лимита. Якорь сюда не попадает — добавим в конец.
  const source = config?.bottom ?? defaultBottom;
  const inBottom = new Set<SectionId>();
  const bottomIds: SectionId[] = [];
  for (const raw of source) {
    const id = raw as SectionId;
    if (!byId.has(id) || isAnchor(id) || hiddenSet.has(id) || inBottom.has(id)) continue;
    inBottom.add(id);
    bottomIds.push(id);
    if (bottomIds.length >= maxBottom) break;
  }

  // «Главная»: сначала в сохранённом пользователем порядке (config.more), затем
  // разделы, которых там нет (новые/не упомянутые), — в порядке реестра, в хвост.
  const moreIds: SectionId[] = [];
  const placed = new Set<SectionId>();
  const eligibleForMore = (id: SectionId) =>
    byId.has(id) && !isAnchor(id) && !hiddenSet.has(id) && !inBottom.has(id);
  for (const s of registry) {
    if (!s.featured || mentioned.has(s.id) || !eligibleForMore(s.id)) continue;
    placed.add(s.id);
    moreIds.push(s.id);
  }
  for (const raw of config?.more ?? []) {
    const id = raw as SectionId;
    if (!eligibleForMore(id) || placed.has(id)) continue;
    placed.add(id);
    moreIds.push(id);
  }
  for (const s of registry) {
    if (!eligibleForMore(s.id) || placed.has(s.id)) continue;
    placed.add(s.id);
    moreIds.push(s.id);
  }

  return {
    // Якорь ПОСЛЕДНИМ: «Ещё» замыкает панель (редизайн 15.11.2026). Порядок
    // остальных вкладок человек задаёт сам.
    bottom: [...bottomIds, anchorId],
    more: moreIds,
    hidden: [...hiddenSet],
  };
}
