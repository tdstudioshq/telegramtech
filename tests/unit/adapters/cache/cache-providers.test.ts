import { describe, expect, it } from 'vitest';
import { MemoryCacheProvider } from '../../../../src/adapters/cache/memory-cache.provider.js';
import { NoopCacheProvider } from '../../../../src/adapters/cache/noop-cache.provider.js';
import { FakeClock } from '../../../fakes/fake-clock.js';

describe('MemoryCacheProvider', () => {
  it('get/set/del round-trip', async () => {
    const cache = new MemoryCacheProvider(new FakeClock());
    await cache.set('k', 'v');
    expect(await cache.get('k')).toBe('v');
    await cache.del('k');
    expect(await cache.get('k')).toBeNull();
  });

  it('entries expire by TTL against the injected clock (no sleeps)', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCacheProvider(clock);
    await cache.set('k', 'v', 60);

    clock.advanceMs(59_999);
    expect(await cache.get('k')).toBe('v');
    clock.advanceMs(1);
    expect(await cache.get('k')).toBeNull();
  });

  it('incr counts atomically and applies TTL on first touch (rate-limit shape)', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCacheProvider(clock);

    expect(await cache.incr('rl:u1', 60)).toBe(1);
    expect(await cache.incr('rl:u1', 60)).toBe(2);
    expect(await cache.incr('rl:u1', 60)).toBe(3);

    clock.advanceMs(60_000); // window rolls over
    expect(await cache.incr('rl:u1', 60)).toBe(1);
  });

  it('expire re-arms an existing key', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCacheProvider(clock);
    await cache.set('k', 'v', 10);
    await cache.expire('k', 120);

    clock.advanceMs(60_000);
    expect(await cache.get('k')).toBe('v');
  });

  it('withLock runs the fn and releases; a held lock skips (advisory semantics)', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCacheProvider(clock);

    let concurrent: { skipped: boolean } | undefined;
    const outer = await cache.withLock('job:sweep', 60, async () => {
      concurrent = await cache.withLock('job:sweep', 60, async () => 'inner');
      return 'outer';
    });

    expect(outer).toEqual({ skipped: false, result: 'outer' });
    expect(concurrent).toEqual({ skipped: true });

    // released after completion
    const again = await cache.withLock('job:sweep', 60, async () => 'again');
    expect(again).toEqual({ skipped: false, result: 'again' });
  });

  it('withLock releases even when fn throws', async () => {
    const cache = new MemoryCacheProvider(new FakeClock());

    await expect(
      cache.withLock('k', 60, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const after = await cache.withLock('k', 60, async () => 'ok');
    expect(after).toEqual({ skipped: false, result: 'ok' });
  });

  it('a crashed holder is unblocked by TTL expiry', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCacheProvider(clock);
    // simulate a lock left behind: acquire and never let the TTL matter until advanced
    await cache.set('lock:stale', '1', 30);
    expect(await cache.withLock('stale', 30, async () => 'x')).toEqual({ skipped: true });

    clock.advanceMs(30_000);
    expect(await cache.withLock('stale', 30, async () => 'x')).toEqual({
      skipped: false,
      result: 'x',
    });
  });
});

describe('NoopCacheProvider', () => {
  it('never stores, never limits, never skips', async () => {
    const cache = new NoopCacheProvider();
    await cache.set('k', 'v', 60);
    expect(await cache.get('k')).toBeNull();
    expect(await cache.incr('k')).toBe(1);
    expect(await cache.incr('k')).toBe(1); // never rate-limits
    expect(await cache.withLock('k', 60, async () => 'ran')).toEqual({
      skipped: false,
      result: 'ran',
    });
  });
});
