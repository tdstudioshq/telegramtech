// ESLint flat config. The import/no-restricted-paths zones encode the module
// dependency graph from docs/SYSTEM_ARCHITECTURE.md §3 — violations fail CI (ADR-018).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
      },
    },
    rules: {
      // Rule 5 (docs/SYSTEM_ARCHITECTURE.md §3): process.env is read only in config/env.ts.
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'process.env is read only in src/config/env.ts; inject config via constructors.',
        },
      ],
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            // Rule 1: core/ imports only shared/.
            { target: './src/core', from: './src/adapters' },
            { target: './src/core', from: './src/jobs' },
            { target: './src/core', from: './src/config' },
            { target: './src/core', from: './src/logging' },
            // shared/ is the leaf layer — imports nothing above it.
            { target: './src/shared', from: './src/core' },
            { target: './src/shared', from: './src/adapters' },
            { target: './src/shared', from: './src/jobs' },
            { target: './src/shared', from: './src/config' },
            // Rule 4: jobs/ call core services, never adapters directly.
            { target: './src/jobs', from: './src/adapters' },
            // Rule 2: adapters never import each other; they meet only through core ports.
            { target: './src/adapters/telegram', from: './src/adapters', except: ['./telegram'] },
            { target: './src/adapters/payments', from: './src/adapters', except: ['./payments'] },
            { target: './src/adapters/content', from: './src/adapters', except: ['./content'] },
            { target: './src/adapters/cache', from: './src/adapters', except: ['./cache'] },
            {
              target: './src/adapters/persistence',
              from: './src/adapters',
              except: ['./persistence'],
            },
          ],
        },
      ],
    },
  },
  {
    // Rule 3: only adapters/persistence touches Drizzle.
    files: ['src/**/*.ts'],
    ignores: ['src/adapters/persistence/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'drizzle-orm', message: 'only adapters/persistence touches Drizzle.' }],
          patterns: [
            { group: ['drizzle-orm/*'], message: 'only adapters/persistence touches Drizzle.' },
          ],
        },
      ],
    },
  },
  {
    // Rule 1: core/ must never see telegraf, drizzle, or supabase. shared/ likewise (leaf layer).
    // Declared after the drizzle-only block so this stricter set wins for core/shared files.
    files: ['src/core/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'telegraf', message: 'core/shared must not know Telegraf exists (rule 1).' },
            { name: 'drizzle-orm', message: 'only adapters/persistence touches Drizzle (rule 3).' },
          ],
          patterns: [
            { group: ['telegraf/*'], message: 'core/shared must not know Telegraf exists.' },
            { group: ['drizzle-orm/*'], message: 'only adapters/persistence touches Drizzle.' },
            { group: ['@supabase/*'], message: 'Supabase is confined to its adapters.' },
          ],
        },
      ],
    },
  },
  {
    // The one place app code may read process.env (rule 5); drizzle.config.ts is
    // tool config executed by drizzle-kit outside the app process, not app code.
    files: ['src/config/env.ts', 'drizzle.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Integration test harness reads TEST_DATABASE_URL — test tooling, not app code.
    files: ['tests/integration/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  prettier,
);
