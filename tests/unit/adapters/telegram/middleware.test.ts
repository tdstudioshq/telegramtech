/**
 * rateLimitMiddleware behaviour (M7.4 fail-open + the previously-uncovered over-limit
 * branch). The limiter must never silence the bot on a cache outage, and must reply +
 * stop the chain when a user exceeds the window.
 */
import { describe, expect, it, vi } from 'vitest';
import { rateLimitMiddleware } from '../../../../src/adapters/telegram/middleware/middleware.js';
import type { CacheProvider } from '../../../../src/core/ports/cache-provider.port.js';
import type { BotContext } from '../../../../src/adapters/telegram/context.js';

const cacheWhereIncr = (incr: () => Promise<number>): CacheProvider => ({
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  del: () => Promise.resolve(),
  expire: () => Promise.resolve(),
  incr,
  withLock: async (_k, _t, fn) => ({ skipped: false, result: await fn() }),
});

const fakeCtx = () => {
  const reply = vi.fn(async () => undefined);
  const warn = vi.fn();
  const ctx = {
    from: { id: 42 },
    log: { warn, info: vi.fn(), error: vi.fn() },
    reply,
  } as unknown as BotContext;
  return { ctx, reply, warn };
};

describe('rateLimitMiddleware', () => {
  it('allows an update under the limit (calls next)', async () => {
    const next = vi.fn(async () => undefined);
    const { ctx } = fakeCtx();
    await rateLimitMiddleware(
      cacheWhereIncr(() => Promise.resolve(1)),
      20,
      60,
    )(ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('blocks and replies when the user exceeds the window (does not call next)', async () => {
    const next = vi.fn(async () => undefined);
    const { ctx, reply } = fakeCtx();
    await rateLimitMiddleware(
      cacheWhereIncr(() => Promise.resolve(21)),
      20,
      60,
    )(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
  });

  it('FAILS OPEN when the cache is unavailable (allows + warns, never silences the bot)', async () => {
    const next = vi.fn(async () => undefined);
    const { ctx, reply, warn } = fakeCtx();
    await rateLimitMiddleware(
      cacheWhereIncr(() => Promise.reject(new Error('redis down'))),
      20,
      60,
    )(ctx, next);
    expect(next).toHaveBeenCalledOnce(); // allowed through
    expect(reply).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled(); // logged the degradation
  });

  it('skips updates with no `from` (service messages)', async () => {
    const next = vi.fn(async () => undefined);
    const incr = vi.fn(() => Promise.resolve(1));
    const ctx = { log: { warn: vi.fn() } } as unknown as BotContext;
    await rateLimitMiddleware(cacheWhereIncr(incr), 20, 60)(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(incr).not.toHaveBeenCalled();
  });
});
