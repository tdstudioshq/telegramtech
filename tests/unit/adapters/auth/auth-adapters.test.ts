/**
 * Real auth adapters (M7.1): scrypt hashing round-trips + rejects wrong passwords
 * and malformed hashes; session tokens are unique and hash deterministically.
 */
import { describe, expect, it } from 'vitest';
import { CryptoSessionTokenService } from '../../../../src/adapters/auth/crypto-session-token.js';
import { ScryptPasswordHasher } from '../../../../src/adapters/auth/scrypt-password-hasher.js';

describe('ScryptPasswordHasher', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hasher = new ScryptPasswordHasher();
    const hash = await hasher.hash('correct-horse');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await hasher.verify('correct-horse', hash)).toBe(true);
    expect(await hasher.verify('wrong', hash)).toBe(false);
  });

  it('rejects a malformed hash without throwing', async () => {
    const hasher = new ScryptPasswordHasher();
    expect(await hasher.verify('x', 'not-a-hash')).toBe(false);
    expect(await hasher.verify('x', 'scrypt$16384$$')).toBe(false);
  });
});

describe('CryptoSessionTokenService', () => {
  it('issues unique tokens whose hash is deterministic and not the token', async () => {
    const tokens = new CryptoSessionTokenService();
    const a = tokens.issue();
    const b = tokens.issue();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(a.token);
    expect(tokens.hash(a.token)).toBe(a.tokenHash); // re-derivable for lookup
  });
});
