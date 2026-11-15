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
  /** Раздел не показывается, пока человек сам его не включит.
   *
   *  Нужен разделам, полезным части людей и бесполезным остальным: приложение
   *  общее, и трекер цикла в списке у того, кому он не нужен, — ровно та
   *  причина, по которой универсальные приложения выглядят перегруженными.
   *  Скрытие срабатывает ТОЛЬКО когда раздел не упомянут в конфиге вообще:
   *  стоит человеку положить его в панель или в «Главную», флаг больше не влияет,
   *  и раздел ведёт себя как любой другой. */
  hiddenByDefault?: boolean;
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

  // Разделы «по запросу»: скрыты, пока не упомянуты в конфиге ни в одном из
  // трёх списков. Проверяем именно упоминание, а не отсутствие в hidden: иначе
  // раздел, однажды показанный и потом снова спрятанный, не отличался бы от
  // никогда не виденного, и любой сброс конфига возвращал бы его на экран.
  const mentioned = new Set<string>([
    ...(config?.bottom ?? []),
    ...(config?.more ?? []),
    ...(config?.hidden ?? []),
  ]);
  for (const s of registry) {
    if (!s.hiddenByDefault || isNonHideable(s.id) || isAnchor(s.id)) continue;
    if (!mentioned.has(s.id)) hiddenSet.add(s.id);
  }

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
