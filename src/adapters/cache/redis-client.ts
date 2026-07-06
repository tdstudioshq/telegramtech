/**
 * Shared ioredis connection (M7.4). One connection serves both the RedisCacheProvider
 * (rate limits, job locks, creator-context sessions) and the RedisNotificationQueue —
 * created once in app.ts and closed on shutdown. ioredis auto-detects TLS from a
 * `rediss://` URL (Railway/Upstash). This is the ONLY file that constructs the client;
 * the providers receive it via their constructors (ports stay infra-agnostic).
 */
import { Redis } from 'ioredis';

export type RedisClient = Redis;

export interface RedisConnection {
  readonly client: RedisClient;
  close(): Promise<void>;
}

/**
 * Per-command deadline (ms). Bounds how long a command waits before it rejects, so a
 * Redis outage FAILS FAST (and the rate-limit boundaries then fail OPEN) instead of
 * hanging every request/update indefinitely. Combined with maxRetriesPerRequest:null,
 * brief reconnect blips are absorbed within the window; a real outage rejects at the
 * deadline. Generous vs our tiny commands (incr, small evals, rpush).
 */
const COMMAND_TIMEOUT_MS = 2000;

export const createRedisConnection = (url: string): RedisConnection => {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    commandTimeout: COMMAND_TIMEOUT_MS,
  });
  let closed = false;
  return {
    client,
    // Idempotent: shutdown may invoke this twice (start()'s failure catch + stop()); the
    // second ioredis quit() on an already-ended client would otherwise reject and derail
    // shutdown. Swallow-and-disconnect on any close error.
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await client.quit().catch(() => client.disconnect());
    },
  };
};
