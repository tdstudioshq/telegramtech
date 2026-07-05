import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../../src/config/env.js';

/** Minimal valid env — only the keys without defaults. */
const validEnv = {
  BOT_TOKEN: '123456:dev-token',
  DATABASE_URL: 'postgresql://user:pass@host:6543/db',
  DATABASE_DIRECT_URL: 'postgresql://user:pass@host:5432/db',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

describe('parseEnv', () => {
  it('parses a minimal valid env and applies documented defaults', () => {
    const result = parseEnv(validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.NODE_ENV).toBe('development');
    expect(result.value.LOG_LEVEL).toBe('info');
    expect(result.value.BOT_MODE).toBe('polling');
    expect(result.value.DEFAULT_CREATOR_SLUG).toBe('demo');
    expect(result.value.PORT).toBe(3000);
    expect(result.value.STORAGE_BUCKET).toBe('drops');
    expect(result.value.SIGNED_URL_TTL_SECONDS).toBe(120);
    expect(result.value.PAYMENT_PROVIDER).toBe('mock');
    expect(result.value.MOCK_PAYMENT_DELAY_MS).toBe(500);
    expect(result.value.MOCK_PAYMENT_FAILURE_RATE).toBe(0);
    expect(result.value.CACHE_PROVIDER).toBe('memory');
    expect(result.value.JOB_SUBSCRIPTION_SWEEP_INTERVAL).toBe(5);
    expect(result.value.JOB_NOTIFICATION_INTERVAL).toBe(1);
    expect(result.value.JOB_CLEANUP_INTERVAL).toBe(30);
    expect(result.value.PENDING_PAYMENT_TTL_MINUTES).toBe(15);
    expect(result.value.RATE_LIMIT_POINTS).toBe(20);
    expect(result.value.RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });

  it('reports the exact offending keys when required values are missing', () => {
    const result = parseEnv({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const keys = result.error.map((issue) => issue.key);
    expect(keys).toContain('BOT_TOKEN');
    expect(keys).toContain('DATABASE_URL');
    expect(keys).toContain('DATABASE_DIRECT_URL');
    expect(keys).toContain('SUPABASE_URL');
    expect(keys).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('treats blank strings as unset (dotenv-style empty values)', () => {
    const result = parseEnv({ ...validEnv, BOT_TOKEN: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((issue) => issue.key)).toContain('BOT_TOKEN');
  });

  it('coerces numeric strings', () => {
    const result = parseEnv({
      ...validEnv,
      SIGNED_URL_TTL_SECONDS: '300',
      MOCK_PAYMENT_FAILURE_RATE: '0.25',
      RATE_LIMIT_POINTS: '50',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.SIGNED_URL_TTL_SECONDS).toBe(300);
    expect(result.value.MOCK_PAYMENT_FAILURE_RATE).toBe(0.25);
    expect(result.value.RATE_LIMIT_POINTS).toBe(50);
  });

  it('rejects out-of-range values (failure rate is 0..1 per Q4)', () => {
    const result = parseEnv({ ...validEnv, MOCK_PAYMENT_FAILURE_RATE: '1.5' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((issue) => issue.key)).toContain('MOCK_PAYMENT_FAILURE_RATE');
  });

  it('rejects unknown enum values', () => {
    const result = parseEnv({ ...validEnv, PAYMENT_PROVIDER: 'stripe' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((issue) => issue.key)).toContain('PAYMENT_PROVIDER');
  });

  it('requires WEBHOOK_URL and WEBHOOK_SECRET_TOKEN when BOT_MODE=webhook (ADR-017)', () => {
    const result = parseEnv({ ...validEnv, BOT_MODE: 'webhook' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const keys = result.error.map((issue) => issue.key);
    expect(keys).toContain('WEBHOOK_URL');
    expect(keys).toContain('WEBHOOK_SECRET_TOKEN');
  });

  it('accepts webhook mode when both webhook values are present', () => {
    const result = parseEnv({
      ...validEnv,
      BOT_MODE: 'webhook',
      WEBHOOK_URL: 'https://bot.example.com/webhook',
      WEBHOOK_SECRET_TOKEN: 'secret',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects production with polling (webhook-only in prod, ADR-020)', () => {
    const result = parseEnv({ ...validEnv, NODE_ENV: 'production', BOT_MODE: 'polling' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((issue) => issue.key)).toContain('BOT_MODE');
  });

  it('accepts production in webhook mode with webhook values present', () => {
    const result = parseEnv({
      ...validEnv,
      NODE_ENV: 'production',
      BOT_MODE: 'webhook',
      WEBHOOK_URL: 'https://bot.example.com/telegram/webhook',
      WEBHOOK_SECRET_TOKEN: 'secret',
    });
    expect(result.ok).toBe(true);
  });
});
