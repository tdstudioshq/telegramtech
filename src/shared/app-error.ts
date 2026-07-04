/**
 * AppError — the E in Result<T, AppError> for expected domain failures (ADR-016).
 * `message` must always be user-safe; internal detail goes in `context` (logged, never shown).
 * Error middleware (M4) maps codes to friendly client output.
 */
export type AppErrorCode =
  | 'validation'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'already_owned'
  | 'payment_failed'
  | 'rate_limited'
  | 'internal';

export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export const appError = (
  code: AppErrorCode,
  message: string,
  context?: Record<string, unknown>,
): AppError => (context === undefined ? { code, message } : { code, message, context });

export const isAppError = (value: unknown): value is AppError =>
  typeof value === 'object' &&
  value !== null &&
  'code' in value &&
  'message' in value &&
  typeof (value as { message: unknown }).message === 'string';
