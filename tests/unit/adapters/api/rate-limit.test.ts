import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { checkRateLimit, clientIp } from '../../../../src/adapters/api/rate-limit.js';
import { MemoryCacheProvider } from '../../../../src/adapters/cache/memory-cache.provider.js';
import type { CacheProvider } from '../../../../src/core/ports/cache-provider.port.js';

const reqWith = (
  headers: Record<string, string>,
  remoteAddress = '203.0.113.50',
): IncomingMessage => {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress });
  const req = new IncomingMessage(socket);
  Object.assign(req.headers, headers);
  return req;
};

describe('clientIp — spoof-resistant client IP resolution', () => {
  it('takes the RIGHTMOST hop (the one the trusted proxy appended), ignoring a spoofed leftmost', () => {
    // Attacker sends "9.9.9.9"; Railway's edge appends the real client "1.2.3.4".
    expect(clientIp(reqWith({ 'x-forwarded-for': '9.9.9.9, 1.2.3.4' }), 1)).toBe('1.2.3.4');
  });

  it('a client-supplied XFF cannot mint a fresh bucket — the attacker value is never used', () => {
    // Every request carries a different spoofed leftmost, but the trusted hop is constant.
    const a = clientIp(reqWith({ 'x-forwarded-for': 'aaaa, 1.2.3.4' }), 1);
    const b = clientIp(reqWith({ 'x-forwarded-for': 'bbbb, 1.2.3.4' }), 1);
    expect(a).toBe('1.2.3.4');
    expect(b).toBe('1.2.3.4'); // same bucket → throttle holds
  });

  it('rejects a non-IP forwarded value and falls back to the socket peer (no keyspace injection)', () => {
    // An attacker trying to collide with the per-email bucket via XFF gets rejected.
    const ip = clientIp(
      reqWith({ 'x-forwarded-for': 'email:victim@example.com' }, '198.51.100.9'),
      1,
    );
    expect(ip).toBe('198.51.100.9');
    expect(ip).not.toContain('email:');
  });

  it('honors a multi-hop trusted-proxy count (client is N from the right)', () => {
    expect(clientIp(reqWith({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 10.0.0.2' }), 2)).toBe(
      '10.0.0.1',
    );
  });

  it('with trustedProxyHops=0 ignores XFF entirely and uses the socket peer', () => {
    expect(clientIp(reqWith({ 'x-forwarded-for': '1.2.3.4' }, '198.51.100.9'), 0)).toBe(
      '198.51.100.9',
    );
  });

  it('falls back to the socket address when no forwarded header is present', () => {
    expect(clientIp(reqWith({}, '198.51.100.9'), 1)).toBe('198.51.100.9');
  });

  it('returns "unknown" when neither a valid forwarded hop nor a valid socket exists', () => {
    expect(clientIp(reqWith({}, ''), 1)).toBe('unknown');
  });
});

describe('checkRateLimit', () => {
  it('allows up to `points` then blocks within the window', async () => {
    const cache = new MemoryCacheProvider();
    const rule = { points: 2, windowSeconds: 60 };
    expect((await checkRateLimit(cache, 'k', rule)).allowed).toBe(true); // count 1
    expect((await checkRateLimit(cache, 'k', rule)).allowed).toBe(true); // count 2
    const blocked = await checkRateLimit(cache, 'k', rule); // count 3
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
  });

  it('keys are independent — a different key has its own bucket', async () => {
    const cache = new MemoryCacheProvider();
    const rule = { points: 1, windowSeconds: 60 };
    expect((await checkRateLimit(cache, 'a', rule)).allowed).toBe(true);
    expect((await checkRateLimit(cache, 'b', rule)).allowed).toBe(true);
    expect((await checkRateLimit(cache, 'a', rule)).allowed).toBe(false);
  });

  it('FAILS OPEN when the cache is unavailable (never take the surface down on a Redis outage)', async () => {
    const downCache: CacheProvider = {
      get: () => Promise.reject(new Error('redis down')),
      set: () => Promise.reject(new Error('redis down')),
      del: () => Promise.reject(new Error('redis down')),
      expire: () => Promise.reject(new Error('redis down')),
      incr: () => Promise.reject(new Error('redis down')),
      withLock: () => Promise.reject(new Error('redis down')),
    };
    const verdict = await checkRateLimit(downCache, 'k', { points: 1, windowSeconds: 60 });
    expect(verdict.allowed).toBe(true);
    expect(verdict.degraded).toBe(true);
  });
});
