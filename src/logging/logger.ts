/**
 * Pino logger (ADR-015): structured JSON, child loggers per module, secret redaction.
 * Pretty-printing happens outside the process (`pnpm dev` pipes through pino-pretty),
 * so output is always JSON — pipes to Railway now, Axiom/Better Stack later.
 */
import { pino, stdTimeFunctions, type Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  readonly level: string;
  readonly name?: string;
}

/** Key patterns whose values must never reach logs (ADR-015 / SETUP.md). */
const REDACT_PATHS = [
  'token',
  '*.token',
  'botToken',
  '*.botToken',
  'secret',
  '*.secret',
  'secretToken',
  '*.secretToken',
  'password',
  '*.password',
  'apiKey',
  '*.apiKey',
  'serviceRoleKey',
  '*.serviceRoleKey',
  'authorization',
  '*.authorization',
  'headers.authorization',
];

export const createLogger = (options: LoggerOptions): Logger =>
  pino({
    name: options.name,
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: stdTimeFunctions.isoTime,
  });
