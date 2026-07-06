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
      // `_`-prefixed params are deliberate no-ops (interface-conforming stubs like NoopCache).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
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
            // Dependency direction: core/shared/adapters must never import the composition
            // (server/) zone. Composition depends on adapters→core→shared, never the reverse.
            { target: './src/core', from: './src/server' },
            { target: './src/shared', from: './src/server' },
            { target: './src/adapters', from: './src/server' },
            // Rule 2: adapters never import each other; they meet only through core ports.
            // Every subdirectory of src/adapters MUST appear here (asserted by
            // tests/unit/config/eslint-boundaries.test.ts so a new adapter can't slip the net).
            { target: './src/adapters/api', from: './src/adapters', except: ['./api'] },
            { target: './src/adapters/auth', from: './src/adapters', except: ['./auth'] },
            { target: './src/adapters/cache', from: './src/adapters', except: ['./cache'] },
            { target: './src/adapters/content', from: './src/adapters', except: ['./content'] },
            {
              target: './src/adapters/notifications',
              from: './src/adapters',
              except: ['./notifications'],
            },
            { target: './src/adapters/payments', from: './src/adapters', except: ['./payments'] },
            {
              target: './src/adapters/persistence',
              from: './src/adapters',
              except: ['./persistence'],
            },
            { target: './src/adapters/telegram', from: './src/adapters', except: ['./telegram'] },
          ],
        },
      ],
    },
  },
  // Infrastructure-package confinement (Rules 1 & 3): each infra package (drizzle-orm,
  // telegraf, @supabase/*, ioredis) is bound to its owning adapter(s) and banned everywhere
  // else. ESLint flat config does not MERGE `no-restricted-imports` across matching entries —
  // the last match wins and replaces — so every layer below restates its full ban set.
  // Ordered general → specific: the general ban applies to core/shared/jobs/config/composition,
  // and each owning adapter re-permits exactly the package(s) it owns. ioredis is shared by
  // the cache AND notifications adapters (M7.4).
  (() => {
    // Each package: the bare-name ban(s) + the subpath pattern ban(s).
    const P = {
      drizzle: {
        names: [
          { name: 'drizzle-orm', message: 'only adapters/persistence touches Drizzle (rule 3).' },
        ],
        patterns: [
          { group: ['drizzle-orm/*'], message: 'only adapters/persistence touches Drizzle.' },
        ],
      },
      telegraf: {
        names: [
          { name: 'telegraf', message: 'Telegraf is confined to adapters/telegram (rule 1/2).' },
        ],
        patterns: [
          { group: ['telegraf/*'], message: 'Telegraf is confined to adapters/telegram.' },
        ],
      },
      supabase: {
        names: [],
        patterns: [
          { group: ['@supabase/*'], message: 'Supabase is confined to adapters/content.' },
        ],
      },
      ioredis: {
        names: [
          {
            name: 'ioredis',
            message: 'ioredis is confined to adapters/cache + adapters/notifications (M7.4).',
          },
        ],
        patterns: [
          {
            group: ['ioredis/*'],
            message: 'ioredis is confined to adapters/cache + adapters/notifications.',
          },
        ],
      },
    };
    const ALL = Object.keys(P);
    // Ban every package EXCEPT those in `allowed` (self-contained per layer — flat config
    // does not merge no-restricted-imports across matches, the last match replaces).
    const rule = (allowed) => {
      const banned = ALL.filter((k) => !allowed.includes(k));
      return {
        'no-restricted-imports': [
          'error',
          {
            paths: banned.flatMap((k) => P[k].names),
            patterns: banned.flatMap((k) => P[k].patterns),
          },
        ],
      };
    };
    return [
      { files: ['src/**/*.ts'], rules: rule([]) }, // default: nobody imports infra packages directly
      { files: ['src/adapters/persistence/**/*.ts'], rules: rule(['drizzle']) },
      { files: ['src/adapters/telegram/**/*.ts'], rules: rule(['telegraf']) },
      { files: ['src/adapters/content/**/*.ts'], rules: rule(['supabase']) },
      { files: ['src/adapters/cache/**/*.ts'], rules: rule(['ioredis']) },
      { files: ['src/adapters/notifications/**/*.ts'], rules: rule(['ioredis']) },
    ];
  })(),
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
