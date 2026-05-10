import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
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
    rules: {
      // The Viewer legitimately cascades state on image load, series change, and drag —
      // the new React 19 rule is too aggressive for this pattern. Disable globally; we
      // exercise judgment per-effect.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      // The Chat component takes `series` for forward-compat but doesn't render it.
      // Allow underscore-prefixed unused params.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
])
