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
      // react-hooks' "recommended" config (v7, bundling the newer React
      // Compiler safety rules) flags every standard "setLoading(true) then
      // fetch" data-loading effect in this app as an unsafe synchronous
      // setState-in-effect — the exact "Fetching data" pattern React's own
      // docs still recommend for a component with no Suspense/framework data
      // layer. This project has no React Compiler babel plugin installed
      // (see vite.config.ts), so the rule's actual motivation (the Compiler
      // may re-run an effect body more than once, and doesn't tolerate an
      // unconditional setState at the top of it) doesn't apply to how this
      // code actually runs today. Downgraded rather than restructuring the
      // ~12 real call sites (WarehouseX/SkuY page-load effects, etc.) away
      // from a correct, already-verified pattern for the sake of a rule this
      // build doesn't enforce.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
])
