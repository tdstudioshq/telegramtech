/**
 * PasswordHasher port (M7.1) — keeps crypto out of core so AuthService stays pure
 * and testable. MVP implementation: ScryptPasswordHasher (node:crypto, no deps).
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}
