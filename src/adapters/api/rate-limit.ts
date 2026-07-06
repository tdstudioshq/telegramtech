/**
 * API rate limiting (M7.3.1) — CacheProvider-backed fixed-window limiter, the same
 * shape as the Telegram rateLimitMiddleware (incr + window TTL; allow while
 * count <= points). Keyed per client IP for the unauthenticated auth + public
 * endpoints and per creator for the authenticated surface (incl. uploads).
 *
 * Per-process today (MemoryCacheProvider) — the counters become shared across
 * replicas automatically when RedisCacheProvider lands (debt #1 / M7.4) with no
 * code change here, because the port already exposes atomic incr.
 */
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { CacheProvider } from '../../core/ports/cache-provider.port.js';

export interface RateLimitRule {
  readonly points: number;
  readonly windowSeconds: number;
}

export interface ApiRateLimits {
  /** Unauthenticated auth endpoints (login/register), keyed by client IP (+ email on login). */
  readonly auth: RateLimitRule;
  /** Unauthenticated public marketplace reads, keyed by client IP. */
  readonly public: RateLimitRule;
  /** Authenticated routes (incl. uploads), keyed by the authenticated creator id. */
  readonly authenticated: RateLimitRule;
}

/**
 * Resolve the real client IP behind `trustedProxyHops` appending reverse proxies.
 *
 * `X-Forwarded-For` is `client, proxy1, proxy2, …` where each trusted proxy APPENDS
 * the address it received from — so with N trusted proxies (Railway's edge = 1) the
 * real client is the Nth entry FROM THE RIGHT. Never trust the leftmost entry: it is
 * fully client-controlled and spoofable, which would let an attacker mint a fresh
 * rate-limit bucket per request. The resolved token must parse as an IP; otherwise we
 * fall back to the socket peer (unspoofable), so a bogus header can never poison a
 * bucket key or collide with another keyspace (e.g. the per-email bucket).
 */
export const clientIp = (req: IncomingMessage, trustedProxyHops = 1): string => {
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (raw !== undefined && trustedProxyHops > 0) {
    const parts = raw.split(',').map((p) => p.trim());
    const candidate = parts[parts.length - trustedProxyHops];
    if (candidate !== undefined && isIP(candidate) !== 0) return candidate;
  }
  const socket = req.socket.remoteAddress;
  return socket !== undefined && isIP(socket) !== 0 ? socket : 'unknown';
};

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  /** True when the cache was unavailable and we FAILED OPEN (allowed without counting). */
  readonly degraded?: boolean;
}

/**
 * Fixed-window check: atomically increment `key` (window TTL applied on create) and
 * allow while the count is within `rule.points`. Identical semantics to the Telegram
 * middleware so the two channels behave the same way.
 *
 * FAIL-OPEN: if the cache is unavailable (e.g. a Redis outage — the shared limiter
 * lives there at scale), allow the request rather than 500 it. A rate limiter must never
 * take the whole surface down; the MemoryCacheProvider never throws, so this preserves
 * that "never block, never hard-deny on infra failure" posture for the Redis backend too.
 */
export const checkRateLimit = async (
  cache: CacheProvider,
  key: string,
  rule: RateLimitRule,
): Promise<RateLimitVerdict> => {
  try {
    const count = await cache.incr(key, rule.windowSeconds);
    return { allowed: count <= rule.points, retryAfterSeconds: rule.windowSeconds };
  } catch {
    return { allowed: true, retryAfterSeconds: rule.windowSeconds, degraded: true };
  }
};
