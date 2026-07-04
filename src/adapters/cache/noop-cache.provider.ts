/**
 * NoopCacheProvider (ADR-007) — for tests and cache-off runs. Never stores,
 * never rate-limits (incr always 1), never skips work (locks always acquire).
 */
import type { CacheProvider } from '../../core/ports/cache-provider.port.js';

export class NoopCacheProvider implements CacheProvider {
  async get(_key: string): Promise<string | null> {
    return null;
  }

  async set(_key: string, _value: string, _ttlSeconds?: number): Promise<void> {}

  async del(_key: string): Promise<void> {}

  async expire(_key: string, _ttlSeconds: number): Promise<void> {}

  async incr(_key: string, _ttlSeconds?: number): Promise<number> {
    return 1;
  }

  async withLock<T>(
    _key: string,
    _ttlSeconds: number,
    fn: () => Promise<T>,
  ): Promise<{ skipped: true } | { skipped: false; result: T }> {
    return { skipped: false, result: await fn() };
  }
}
