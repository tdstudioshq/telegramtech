/**
 * Env validation — Zod parse-or-crash (ADR-013, SETUP.md).
 * This is the ONLY file in the codebase that reads process.env (rule 5);
 * everything else receives config via constructors.
 *
 * `parseEnv` is pure (testable); `loadEnv` prints the exact offending keys and exits 1.
 */
import { z } from 'zod';
import { err, ok, type Result } from '../shared/result.js';

const envSchema = z
  .object({
    // Runtime
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // Telegram (first client adapter)
    BOT_TOKEN: z.string().min(1),
    BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
    // Shared-bot fallback storefront when /start carries no deep-link payload (M7.0).
    DEFAULT_CREATOR_SLUG: z.string().min(1).default('demo'),
    // Shared-bot @username (no @) for marketplace deep-links (M7.3); optional.
    BOT_USERNAME: z.string().min(1).optional(),
    WEBHOOK_URL: z.url().optional(),
    WEBHOOK_SECRET_TOKEN: z.string().min(1).optional(),
    PORT: z.coerce.number().int().positive().max(65_535).default(3000),

    // Database
    DATABASE_URL: z.string().min(1),
    DATABASE_DIRECT_URL: z.string().min(1),

    // Content storage (Supabase Storage — ADR-006)
    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    STORAGE_BUCKET: z.string().min(1).default('drops'),
    SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(120),

    // Payments
    PAYMENT_PROVIDER: z.enum(['mock', 'telegram_stars']).default('mock'),
    MOCK_PAYMENT_DELAY_MS: z.coerce.number().int().min(0).default(500),
    MOCK_PAYMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),

    // Cache
    CACHE_PROVIDER: z.enum(['memory', 'noop', 'redis']).default('memory'),
    REDIS_URL: z.string().min(1).optional(),

    // Dashboard/API auth (M7.1) — bearer session lifetime
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(720),

    // Jobs (minutes)
    JOB_SUBSCRIPTION_SWEEP_INTERVAL: z.coerce.number().int().positive().default(5),
    JOB_NOTIFICATION_INTERVAL: z.coerce.number().int().positive().default(1),
    JOB_CLEANUP_INTERVAL: z.coerce.number().int().positive().default(30),
    PENDING_PAYMENT_TTL_MINUTES: z.coerce.number().int().positive().default(15),

    // Rate limiting — Telegram bot (per Telegram user)
    RATE_LIMIT_POINTS: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    // Rate limiting — JSON API (M7.3.1). Auth bucket: per client IP on login/register
    // (a second per-email bucket also applies to login). Public bucket: per client IP
    // on the unauthenticated marketplace reads. Authenticated bucket: per creator over
    // the whole dashboard surface, including uploads.
    API_AUTH_RATE_LIMIT_POINTS: z.coerce.number().int().positive().default(10),
    API_AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    API_PUBLIC_RATE_LIMIT_POINTS: z.coerce.number().int().positive().default(60),
    API_PUBLIC_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    API_RATE_LIMIT_POINTS: z.coerce.number().int().positive().default(120),
    API_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    // Number of trusted appending reverse proxies in front of the app (Railway edge = 1).
    // The real client IP is taken this many hops from the right of X-Forwarded-For.
    API_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  })
  .superRefine((env, ctx) => {
    if (env.BOT_MODE === 'webhook') {
      if (env.WEBHOOK_URL === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEBHOOK_URL'],
          message: 'required when BOT_MODE=webhook',
        });
      }
      if (env.WEBHOOK_SECRET_TOKEN === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEBHOOK_SECRET_TOKEN'],
          message: 'required when BOT_MODE=webhook',
        });
      }
    }
    // Production is webhook-only (ADR-017/ADR-020): long-polling is a dev convenience
    // and cannot fast-ack Telegram's retries or verify a secret token.
    if (env.NODE_ENV === 'production' && env.BOT_MODE !== 'webhook') {
      ctx.addIssue({
        code: 'custom',
        path: ['BOT_MODE'],
        message: 'must be webhook when NODE_ENV=production (polling is dev-only)',
      });
    }
    // Redis mode (M7.4) needs a connection string; it backs the shared cache AND the
    // shared notification queue, which is what makes numReplicas>1 safe.
    if (env.CACHE_PROVIDER === 'redis' && env.REDIS_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'required when CACHE_PROVIDER=redis',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface EnvIssue {
  readonly key: string;
  readonly message: string;
}

/** Blank values in .env files arrive as '' — treat them as unset so defaults/required kick in. */
const stripBlank = (source: Record<string, string | undefined>): Record<string, string> => {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') cleaned[key] = value;
  }
  return cleaned;
};

export const parseEnv = (source: Record<string, string | undefined>): Result<Env, EnvIssue[]> => {
  const parsed = envSchema.safeParse(stripBlank(source));
  if (parsed.success) return ok(parsed.data);
  return err(
    parsed.error.issues.map((issue) => ({
      key: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  );
};

/** Parse-or-crash: prints the exact offending keys, exits 1, nothing connects. */
export const loadEnv = (source: Record<string, string | undefined> = process.env): Env => {
  const result = parseEnv(source);
  if (result.ok) return result.value;
  console.error('Invalid environment configuration:');
  for (const issue of result.error) {
    console.error(`  - ${issue.key}: ${issue.message}`);
  }
  process.exit(1);
};
