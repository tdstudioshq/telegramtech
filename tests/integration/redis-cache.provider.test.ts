/**
 * RedisCacheProvider against a real Redis (M7.4). Verifies the CacheProvider contract
 * plus the distributed-lock and atomic-incr semantics that make numReplicas>1 safe.
 * Requires REDIS_TEST_URL, e.g.
 *   docker run -d --name creator-platform-test-redis -p 63790:6379 redis:7-alpine
 *   REDIS_TEST_URL=redis://localhost:63790 TEST_DATABASE_URL=... pnpm test:integration
 */
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisCacheProvider } from '../../src/adapters/cache/redis-cache.provider.js';
import { createRedisConnection } from '../../src/adapters/cache/redis-client.js';

const REDIS_URL = process.env['REDIS_TEST_URL'];

describe.skipIf(!REDIS_URL)('RedisCacheProvider (real Redis)', () => {
  const redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: null });
  const cache = new RedisCacheProvider(redis);

  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('get/set/del/expire round-trip', async () => {
    expect(await cache.get('k')).toBeNull();
    await cache.set('k', 'v');
    expect(await cache.get('k')).toBe('v');
    await cache.set('k', 'v2', 100);
    expect(await redis.ttl('k')).toBeGreaterThan(0);
    await cache.del('k');
    expect(await cache.get('k')).toBeNull();
  });

  it('incr sets the window TTL only when it CREATES the key', async () => {
    expect(await cache.incr('rate', 30)).toBe(1);
    const ttlAfterCreate = await redis.ttl('rate');
    expect(ttlAfterCreate).toBeGreaterThan(0);
    expect(ttlAfterCreate).toBeLessThanOrEqual(30);

    expect(await cache.incr('rate', 30)).toBe(2); // subsequent incr keeps the window
    expect(await redis.ttl('rate')).toBeGreaterThan(0);

    // no ttl requested → key persists (matches MemoryCacheProvider)
    expect(await cache.incr('noexp')).toBe(1);
    expect(await redis.ttl('noexp')).toBe(-1);
  });

  it('withLock runs fn and releases the lock afterwards', async () => {
    let ran = false;
    const out = await cache.withLock('job', 60, async () => {
      ran = true;
      expect(await redis.exists('lock:job')).toBe(1); // held during fn
      return 42;
    });
    expect(ran).toBe(true);
    expect(out).toEqual({ skipped: false, result: 42 });
    expect(await redis.exists('lock:job')).toBe(0); // released after
  });

  it('withLock SKIPS (does not wait) when the lock is already held', async () => {
    await redis.set('lock:job', 'someone-else', 'EX', 60, 'NX');
    let ran = false;
    const out = await cache.withLock('job', 60, async () => {
      ran = true;
      return 1;
    });
    expect(ran).toBe(false);
    expect(out).toEqual({ skipped: true });
    expect(await redis.get('lock:job')).toBe('someone-else'); // untouched
  });

  it('two concurrent withLock calls: exactly one runs, the other skips', async () => {
    const gate = new Promise((r) => setTimeout(r, 120));
    const results = await Promise.all([
      cache.withLock('c', 60, async () => {
        await gate;
        return 'a';
      }),
      cache.withLock('c', 60, async () => {
        await gate;
        return 'b';
      }),
    ]);
    const ran = results.filter((r) => r.skipped === false);
    const skipped = results.filter((r) => r.skipped === true);
    expect(ran).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  it('safe release: never deletes a lock it no longer owns (compare-and-del)', async () => {
    // Simulate our lock expiring and another owner taking it mid-run: our finally-release
    // must NOT delete the new owner's lock.
    await cache.withLock('steal', 60, async () => {
      await redis.set('lock:steal', 'new-owner'); // overwrite with a different token
    });
    expect(await redis.get('lock:steal')).toBe('new-owner'); // our release left it intact
  });

  it('connection close() is idempotent — a second close is a harmless no-op', async () => {
    const conn = createRedisConnection(REDIS_URL as string);
    expect(await conn.client.ping()).toBe('PONG');
    await conn.close();
    // Double-close on shutdown (start-failure catch + stop) must not reject.
    await expect(conn.close()).resolves.toBeUndefined();
  });
});
