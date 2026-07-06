/**
 * Minimal HTTP helpers for the JSON API adapter (M7.1): body reading, JSON
 * responses, and the AppError→status mapping so the dashboard/SPA/mobile/public
 * API all get consistent errors. No framework — Node http only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appError, type AppError, type AppErrorCode } from '../../shared/app-error.js';
import type { Result } from '../../shared/result.js';

const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB (covers dashboard media uploads)

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  already_owned: 409,
  payment_failed: 402,
  rate_limited: 429,
  internal: 500,
};

/** BigInt (e.g. DropAsset.fileSizeBytes) isn't JSON-serializable — emit it as a string. */
const jsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

export const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body, jsonReplacer);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

export const sendError = (res: ServerResponse, error: AppError): void =>
  sendJson(res, STATUS_BY_CODE[error.code], {
    error: { code: error.code, message: error.message },
  });

/** 429 with a Retry-After header (set before writeHead so it survives the merge). */
export const sendRateLimited = (res: ServerResponse, retryAfterSeconds: number): void => {
  res.setHeader('retry-after', String(retryAfterSeconds));
  sendError(
    res,
    appError('rate_limited', 'Too many requests. Please slow down and try again in a moment.'),
  );
};

/** Send `result.value` (status `okStatus`) or map its AppError to the right status. */
export const sendResult = <T>(
  res: ServerResponse,
  result: Result<T, AppError>,
  okStatus = 200,
): void => (result.ok ? sendJson(res, okStatus, result.value) : sendError(res, result.error));

export const readRawBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

export const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString('utf8'));
};

/** Extract the bearer token from the Authorization header. */
export const bearerToken = (req: IncomingMessage): string | null => {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
};
