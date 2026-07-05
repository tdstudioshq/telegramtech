/**
 * ScryptPasswordHasher (M7.1) — node:crypto scrypt, no external deps. Stores a
 * self-describing string `scrypt$N$saltHex$hashHex`; verify is constant-time.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { PasswordHasher } from '../../core/ports/password-hasher.port.js';

const KEYLEN = 64;
const COST = 16_384; // scrypt N

/** Promise wrapper that keeps the options overload (promisify drops it). */
const scryptAsync = (password: string, salt: Buffer, keylen: number, cost: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N: cost }, (err, derived) =>
      err ? reject(err) : resolve(derived),
    );
  });

export class ScryptPasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await scryptAsync(plain, salt, KEYLEN, COST);
    return `scrypt$${COST}$${salt.toString('hex')}$${derived.toString('hex')}`;
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    const parts = hash.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    const cost = Number(parts[1]);
    const salt = Buffer.from(parts[2] ?? '', 'hex');
    const expected = Buffer.from(parts[3] ?? '', 'hex');
    if (!Number.isInteger(cost) || salt.length === 0 || expected.length === 0) return false;
    const derived = await scryptAsync(plain, salt, expected.length, cost);
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  }
}
