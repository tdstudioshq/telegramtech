/**
 * Guards the architecture-boundary ESLint config (M7.3.1): every subdirectory of
 * src/adapters MUST appear as an isolation `target` in import/no-restricted-paths,
 * so a newly-added adapter cannot silently bypass Rule 2 (adapters never import each
 * other). Reads the actual config file so the assertion tracks reality, not a copy.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it, vi } from 'vitest';

// The behavioral tests below load full ESLint in-process and parse TypeScript, which can
// exceed the default 5s timeout under parallel suite load / slow CI runners. Give the
// whole file generous headroom (the structural tests finish in ms regardless).
vi.setConfig({ testTimeout: 30_000 });

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// eslint.config.js is untyped JS (no import types) — assert against its source text.
const configSource = readFileSync(resolve(repoRoot, 'eslint.config.js'), 'utf8');

const adapterDirs = readdirSync(resolve(repoRoot, 'src/adapters'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

/** True if the config declares an isolation zone whose target is exactly `path`. */
const hasTarget = (path: string): boolean =>
  new RegExp(`target:\\s*'${path.replace(/[/.]/g, '\\$&')}'`).test(configSource);

/** True if the config declares a zone with the given target and from. */
const hasZone = (target: string, from: string): boolean =>
  new RegExp(
    `target:\\s*'${target.replace(/[/.]/g, '\\$&')}',\\s*from:\\s*'${from.replace(/[/.]/g, '\\$&')}'`,
  ).test(configSource);

describe('ESLint architecture boundaries', () => {
  it('zones every adapter subdirectory as an isolation target (no adapter can bypass Rule 2)', () => {
    for (const dir of adapterDirs) {
      expect(
        hasTarget(`./src/adapters/${dir}`),
        `adapters/${dir} is not an isolation target in eslint.config.js — add a zone for it`,
      ).toBe(true);
    }
  });

  it('zones the composition (server/) layer against core, shared, and adapters', () => {
    expect(hasZone('./src/core', './src/server')).toBe(true);
    expect(hasZone('./src/shared', './src/server')).toBe(true);
    expect(hasZone('./src/adapters', './src/server')).toBe(true);
  });
});

// Behavioral: actually lint synthetic files through the real flat config so the
// layered infra-package confinement (the IIFE + flat-config last-wins) is exercised
// end-to-end — a regression in the flattening or ordering fails CI, not just a text drift.
describe('ESLint infra-package confinement (behavioral)', () => {
  const eslint = new ESLint({ cwd: repoRoot });

  /** True if linting `code` at `relPath` reports a no-restricted-imports error. */
  const bans = async (relPath: string, code: string): Promise<boolean> => {
    const [result] = await eslint.lintText(code, { filePath: resolve(repoRoot, relPath) });
    return (result?.messages ?? []).some((m) => m.ruleId === 'no-restricted-imports');
  };

  const TELEGRAF = `import { Telegraf } from 'telegraf';\nexport const x = Telegraf;\n`;
  const DRIZZLE = `import { eq } from 'drizzle-orm';\nexport const x = eq;\n`;
  const SUPABASE = `import { createClient } from '@supabase/supabase-js';\nexport const x = createClient;\n`;
  const IOREDIS = `import { Redis } from 'ioredis';\nexport const x = Redis;\n`;

  it('core bans telegraf, drizzle-orm, @supabase/*, and ioredis', async () => {
    expect(await bans('src/core/__probe.ts', TELEGRAF)).toBe(true);
    expect(await bans('src/core/__probe.ts', DRIZZLE)).toBe(true);
    expect(await bans('src/core/__probe.ts', SUPABASE)).toBe(true);
    expect(await bans('src/core/__probe.ts', IOREDIS)).toBe(true);
  });

  it('adapters/persistence allows drizzle-orm but still bans telegraf + @supabase + ioredis', async () => {
    expect(await bans('src/adapters/persistence/__probe.ts', DRIZZLE)).toBe(false);
    expect(await bans('src/adapters/persistence/__probe.ts', TELEGRAF)).toBe(true);
    expect(await bans('src/adapters/persistence/__probe.ts', SUPABASE)).toBe(true);
    expect(await bans('src/adapters/persistence/__probe.ts', IOREDIS)).toBe(true);
  });

  it('adapters/telegram allows telegraf but still bans drizzle-orm + @supabase', async () => {
    expect(await bans('src/adapters/telegram/__probe.ts', TELEGRAF)).toBe(false);
    expect(await bans('src/adapters/telegram/__probe.ts', DRIZZLE)).toBe(true);
    expect(await bans('src/adapters/telegram/__probe.ts', SUPABASE)).toBe(true);
  });

  it('adapters/content allows @supabase but still bans drizzle-orm + telegraf', async () => {
    expect(await bans('src/adapters/content/__probe.ts', SUPABASE)).toBe(false);
    expect(await bans('src/adapters/content/__probe.ts', DRIZZLE)).toBe(true);
    expect(await bans('src/adapters/content/__probe.ts', TELEGRAF)).toBe(true);
  });

  it('adapters/cache + adapters/notifications allow ioredis but still ban the others', async () => {
    // ioredis is shared by both adapters (M7.4): the shared connection is created in
    // adapters/cache and the queue in adapters/notifications.
    expect(await bans('src/adapters/cache/__probe.ts', IOREDIS)).toBe(false);
    expect(await bans('src/adapters/cache/__probe.ts', DRIZZLE)).toBe(true);
    expect(await bans('src/adapters/notifications/__probe.ts', IOREDIS)).toBe(false);
    expect(await bans('src/adapters/notifications/__probe.ts', TELEGRAF)).toBe(true);
  });
});
