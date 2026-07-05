/**
 * CryptoSessionTokenService (M7.1) — 256-bit random bearer tokens; only their
 * SHA-256 hash is persisted. node:crypto, no external deps.
 */
import { createHash, randomBytes } from 'node:crypto';
import type {
  IssuedToken,
  SessionTokenService,
} from '../../core/ports/session-token.port.js';

export class CryptoSessionTokenService implements SessionTokenService {
  issue(): IssuedToken {
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
