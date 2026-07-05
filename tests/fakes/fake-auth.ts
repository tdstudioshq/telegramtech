/**
 * Deterministic fakes for the auth ports so AuthService unit tests stay fast
 * (no real scrypt) and assertable. The real adapters are covered separately.
 */
import type { PasswordHasher } from '../../src/core/ports/password-hasher.port.js';
import type { IssuedToken, SessionTokenService } from '../../src/core/ports/session-token.port.js';

export class FakePasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return `h:${plain}`;
  }
  async verify(plain: string, hash: string): Promise<boolean> {
    return hash === `h:${plain}`;
  }
}

export class FakeSessionTokenService implements SessionTokenService {
  private seq = 0;
  issue(): IssuedToken {
    const token = `tok-${(this.seq += 1)}`;
    return { token, tokenHash: this.hash(token) };
  }
  hash(token: string): string {
    return `hash:${token}`;
  }
}
