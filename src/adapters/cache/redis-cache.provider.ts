/**
 * RedisCacheProvider (M7.4) — the CacheProvider port over Redis, so rate-limit
 * counters, job locks, and creator-context sessions become SHARED across replicas
 * (repays debt #1; unpins numReplicas>1). Semantics mirror MemoryCacheProvider so the
 * swap is behaviour-preserving:
 *   - incr applies the window TTL only when it CREATES the key (first increment),
 *   - withLock is skip-not-wait (returns {skipped:true} when the lock is held),
 * but the lock is now a TRUE distributed lock (SET NX PX + a per-acquisition fencing
 * token, released only by its owner) rather than the single-process check-and-set.
 *
 * Correctness never depends on the lock (SYSTEM_ARCHITECTURE §7): the guarded jobs are
 * idempotent and safe to double-run, so there is deliberately no lock auto-renewal — a
 * job outliving its TTL at worst runs concurrently on another replica, which the
 * idempotent sweeps and the shared notification queue already tolerate.
 */
import { randomUUID } from 'node:crypto';
import type { CacheProvider } from '../../core/ports/cache-provider.port.js';
import type { RedisClient } from './redis-client.js';

// INCR then, only when the key was just created (v==1) and a TTL was requested, set it —
// atomic, so a crash can never leave a counter without its window expiry.
const INCR_WITH_TTL = `
local v = redis.call('INCR', KEYS[1])
if v == 1 and tonumber(ARGV[1]) > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return v`;

// Release the lock ONLY if we still own it (token match) — never delete another
// replica's lock that acquired the key after ours expired.
const RELEASE_IF_OWNER = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export class RedisCacheProvider implements CacheProvider {
  constructor(private readonly redis: RedisClient) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds === undefined) {
      await this.redis.set(key, value);
    } else {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(key, ttlSeconds);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const result = await this.redis.eval(INCR_WITH_TTL, 1, key, ttlSeconds ?? 0);
    return Number(result);
  }

  async withLock<T>(
    key: string,
    ttlSeconds: number,
    fn: () => Promise<T>,
  ): Promise<{ skipped: true } | { skipped: false; result: T }> {
    const lockKey = `lock:${key}`;
    const token = randomUUID();
    const acquired = await this.redis.set(lockKey, token, 'EX', ttlSeconds, 'NX');
    if (acquired === null) return { skipped: true };
    try {
      return { skipped: false, result: await fn() };
    } finally {
      await this.redis.eval(RELEASE_IF_OWNER, 1, lockKey, token);
    }
  }
}
