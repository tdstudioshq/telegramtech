/**
 * CreatorContext (M7.0) — slug parsing, deep-link resolution, session persistence,
 * and default-storefront fallback. No Telegraf; drives the resolver directly.
 */
import { describe, expect, it } from 'vitest';
import { MemoryCacheProvider } from '../../../../src/adapters/cache/memory-cache.provider.js';
import {
  CreatorContext,
  parseCreatorSlug,
} from '../../../../src/adapters/telegram/creator-context.js';
import { CreatorService } from '../../../../src/core/services/creator.service.js';
import { createWorld, givenCreator } from '../../../fakes/world.js';

describe('parseCreatorSlug', () => {
  it('strips the c_ deep-link prefix and trims', () => {
    expect(parseCreatorSlug('c_demo')).toBe('demo');
    expect(parseCreatorSlug('  c_alpha ')).toBe('alpha');
    expect(parseCreatorSlug('bare')).toBe('bare');
  });
  it('treats empty/blank/null as no slug', () => {
    expect(parseCreatorSlug(null)).toBeNull();
    expect(parseCreatorSlug('')).toBeNull();
    expect(parseCreatorSlug('   ')).toBeNull();
  });
});

const setup = async () => {
  const world = createWorld();
  const creators = new CreatorService(world.uow);
  const cache = new MemoryCacheProvider(world.clock);
  const def = await givenCreator(world, { slug: 'demo' });
  const other = await givenCreator(world, { slug: 'alpha' });
  const context = new CreatorContext(cache, creators, 'demo');
  return { world, context, def, other };
};

describe('CreatorContext', () => {
  it('resolves a deep-link payload to its creator (and null for unknown/none)', async () => {
    const { context, other } = await setup();
    expect((await context.fromPayload('c_alpha'))?.id).toBe(other.id);
    expect(await context.fromPayload('c_missing')).toBeNull();
    expect(await context.fromPayload(null)).toBeNull();
  });

  it('falls back to the default storefront when there is no session', async () => {
    const { context, def } = await setup();
    expect(await context.current(42)).toBe(def.id);
  });

  it('remembers a creator per Telegram user, overriding the default', async () => {
    const { context, def, other } = await setup();
    await context.remember(42, other.id);
    expect(await context.current(42)).toBe(other.id); // session wins
    expect(await context.current(99)).toBe(def.id); // a different user still gets default
  });

  it('returns null when the default slug matches no creator', async () => {
    const world = createWorld();
    const context = new CreatorContext(
      new MemoryCacheProvider(world.clock),
      new CreatorService(world.uow),
      'nonexistent',
    );
    expect(await context.current(1)).toBeNull();
  });
});
