import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'dev-dist', 'server/dist']),

  // Frontend app — browser globals + React rules.
  {
    files: ['src/**/*.{ts,tsx}'],
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
      // The classic correctness rule (rules-of-hooks) and exhaustive-deps stay
      // on. The two overrides below dial back React-Compiler-era hints that flag
      // pre-existing, intentional patterns in this codebase:
      //
      // - `refs`: we assign `ref.current = value` during render to keep a
      //   "latest value" ref for stable sync callbacks. Deferring it into an
      //   effect would make the ref lag a render and risk stale reads, so this
      //   pattern is deliberate — disable the rule rather than regress it.
      'react-hooks/refs': 'off',
      // - `set-state-in-effect`: the flagged effects reset/lazy-load state when
      //   a dependency changes (clear error on note switch, load backups on tab
      //   open, reset media URL on id change). These are legitimate; keep them
      //   visible as warnings to revisit during the planned component refactor,
      //   but don't block CI.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },

  // Sync server — Node TypeScript, no browser/React rules.
  {
    files: ['server/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Build scripts — plain Node ESM (no TS type-checking rules).
  {
    files: ['scripts/**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
      sourceType: 'module',
    },
  },
])
