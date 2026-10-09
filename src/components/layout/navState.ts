// Пометки источника перехода для NavRouter — кладутся в state ссылки. Без
// пометки переход считается движением вглубь. Отдельно от NavRouter.tsx:
// константы рядом с компонентом ломают Fast Refresh
// (react-refresh/only-export-components).
export const NAV_TAB = { nav: 'tab' } as const;
export const NAV_BACK = { nav: 'back' } as const;
