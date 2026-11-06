import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // .claude/worktrees — рабочие копии параллельных сессий внутри репозитория
  // (в .git/info/exclude они есть, а eslint про них не знает). Без этой строки
  // `eslint .` разбирает и их: одинаковые файлы под несколькими корнями
  // tsconfig дают «No tsconfigRootDir was set» на каждом — 04.11 это были 1796
  // ошибок парсинга, за которыми не видно своих.
  globalIgnores(['dist', '.claude']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
])
