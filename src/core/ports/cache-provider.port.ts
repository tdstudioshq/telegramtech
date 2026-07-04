/**
 * CacheProvider port (ADR-007) — Redis-SHAPED, not Redis-bound: get/set/del/
 * expire/incr/withLock with TTL-seconds semantics chosen so Redis satisfies them
 * exactly. Consumers: rate limiter, job locks, idempotency fast-path, hot settings.
 */
export interface CacheProvider {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  /** Atomic increment; creates the key at 1 (applying ttlSeconds) when absent. */
  incr(key: string, ttlSeconds?: number): Promise<number>;
  /**
   * Run `fn` while holding an advisory lock (SET NX + token semantics). Returns
   * `skipped: true` without running when the lock is already held — job-sweep
   * semantics: correctness never depends on the lock (SYSTEM_ARCHITECTURE §7).
   */
  withLock<T>(
    key: string,
    ttlSeconds: number,
    fn: () => Promise<T>,
  ): Promise<{ skipped: true } | { skipped: false; result: T }>;
}
