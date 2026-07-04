/**
 * MemoryCacheProvider (ADR-007) — MVP cache: per-process Map with lazy TTL
 * eviction. Semantics deliberately mirror Redis (SET NX-style locks, atomic-ish
 * incr — atomic is trivial single-threaded) so RedisCacheProvider is a drop-in.
 * Per-process is tracked debt #1; trigger: second instance.
 */
import type { CacheProvider } from '../../core/ports/cache-provider.port.js';
import type { Clock } from '../../core/ports/clock.port.js';

interface Entry {
  value: string;
  /** null = no TTL */
  expiresAtMs: number | null;
}

const systemClock: Clock = { now: () => new Date() };

export class MemoryCacheProvider implements CacheProvider {
  private readonly store = new Map<string, Entry>();

  constructor(private readonly clock: Clock = systemClock) {}

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.store.set(key, { value, expiresAtMs: this.expiry(ttlSeconds) });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    const entry = this.live(key);
    if (entry !== null) entry.expiresAtMs = this.expiry(ttlSeconds);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const entry = this.live(key);
    if (entry === null) {
      this.store.set(key, { value: '1', expiresAtMs: this.expiry(ttlSeconds) });
      return 1;
    }
    const next = Number(entry.value) + 1;
    entry.value = String(next);
    return next;
  }

  async withLock<T>(
    key: string,
    ttlSeconds: number,
    fn: () => Promise<T>,
  ): Promise<{ skipped: true } | { skipped: false; result: T }> {
    const lockKey = `lock:${key}`;
    if (this.live(lockKey) !== null) return { skipped: true };
    this.store.set(lockKey, { value: '1', expiresAtMs: this.expiry(ttlSeconds) });
    try {
      return { skipped: false, result: await fn() };
    } finally {
      this.store.delete(lockKey);
    }
  }

  /** Returns the entry if present and unexpired; evicts lazily otherwise. */
  private live(key: string): Entry | null {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= this.clock.now().getTime()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  private expiry(ttlSeconds?: number): number | null {
    return ttlSeconds === undefined ? null : this.clock.now().getTime() + ttlSeconds * 1000;
  }
}
